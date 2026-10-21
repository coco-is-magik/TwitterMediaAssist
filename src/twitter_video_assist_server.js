const activeRequests = new Map()
const activeConversions = new Set()
const CAPTURE_INTERVAL = 66
const CONVERSION_TIMEOUT = 30000

browser.runtime.onMessage.addListener(processRequest)

function processRequest(request) {
    const handlers = { video: downloadMp4Video, image: downloadImage, gif: processGifVideo }
    if (!Object.prototype.hasOwnProperty.call(handlers, request.type)) return
    let key
    try {
        key = mediaKey(request)
    } catch (error) {
        return Promise.resolve({ error: error.message })
    }
    if (activeRequests.has(key)) return activeRequests.get(key)
    const task = Promise.resolve().then(() => handlers[request.type](request))
        .then(() => ({ success: true }), error => ({ error: error.message }))
        .finally(() => activeRequests.delete(key))
    activeRequests.set(key, task)
    return task
}

function convertGif(url, readableFilename) {
    return new Promise((resolve, reject) => {
        let worker, video, canvas, context, timer
        let state = 'loading'
        let frameIndex = 0
        const job = {}

        function cleanup() {
            clearTimeout(timer)
            if (worker) {
                worker.onmessage = worker.onerror = worker.onmessageerror = null
                worker.terminate()
            }
            if (video) {
                video.onloadeddata = video.onseeked = video.onerror = null
                video.pause()
                video.removeAttribute('src')
                video.load()
            }
            if (canvas) canvas.width = canvas.height = 0
            activeConversions.delete(job)
            if (!activeConversions.size) sendSpinnerStateMessage(true)
        }
        function fail(error) {
            if (state === 'done') return
            state = 'done'
            cleanup()
            reject(error)
        }
        function armTimeout() {
            clearTimeout(timer)
            timer = setTimeout(() => fail(new Error('GIF conversion timed out')), CONVERSION_TIMEOUT)
        }
        function post(message, transfer = []) {
            armTimeout()
            worker.postMessage(message, transfer)
        }
        function frame() {
            state = 'encoding'
            context.drawImage(video, 0, 0, canvas.width, canvas.height)
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
            post({ type: 'frame', buffer: pixels.buffer }, [pixels.buffer])
        }
        function guarded(callback) {
            return event => {
                if (state === 'done') return
                try { callback(event) } catch (error) { fail(error) }
            }
        }

        try {
            worker = new Worker('gif_converter.js')
            canvas = document.createElement('canvas')
            context = canvas.getContext('2d')
            video = document.createElement('video')
            activeConversions.add(job)
            sendSpinnerStateMessage(false)
            video.onloadeddata = guarded(() => {
                if (state !== 'loading') return
                if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) {
                    throw new Error('Invalid GIF video dimensions or duration')
                }
                state = 'starting'
                canvas.width = video.videoWidth
                canvas.height = video.videoHeight
                post({ type: 'start', delay: CAPTURE_INTERVAL, w: canvas.width, h: canvas.height })
            })
            video.onseeked = guarded(() => {
                if (state === 'seeking') frame()
            })
            video.onerror = () => fail(new Error('GIF video failed to load'))
            worker.onerror = event => {
                event.preventDefault()
                fail(new Error(event.message || 'GIF worker failed'))
            }
            worker.onmessageerror = () => fail(new Error('GIF worker message failed'))
            worker.onmessage = guarded(event => {
                const message = event.data
                if (message.type === 'error') throw new Error(message.error)
                if (message.type === 'ready' && state === 'starting') {
                    frame()
                } else if (message.type === 'frame' && state === 'encoding') {
                    const nextTime = ++frameIndex * CAPTURE_INTERVAL / 1000
                    if (nextTime >= video.duration) {
                        state = 'finishing'
                        post({ type: 'finish' })
                    } else {
                        state = 'seeking'
                        armTimeout()
                        video.currentTime = nextTime
                    }
                } else if (message.type === 'finished' && state === 'finishing') {
                    state = 'done'
                    cleanup()
                    Promise.resolve().then(() => browser.storage.sync.get({
                        spcificPathName: false, readableName: false
                    })).then(items => {
                        const blob = new Blob([message.buffer], { type: 'image/gif' })
                        const filename = new URL(url).pathname.split('/').pop().split('.')[0]
                        return downloadFile({
                            url: URL.createObjectURL(blob),
                            saveAs: items.spcificPathName,
                            filename: (items.readableName ? readableFilename : filename) + '.gif'
                        }, true)
                    }).then(resolve, reject)
                }
            })
            video.crossOrigin = 'use-credentials'
            video.preload = 'auto'
            armTimeout()
            video.src = url
            video.load()
        } catch (error) {
            fail(error)
        }
    })
}

function sendSpinnerStateMessage(hide) {
    browser.tabs.query({
        currentWindow: true,
        url: ['*://*.twitter.com/*', '*://twitter.com/*', '*://*.x.com/*', '*://x.com/*']
    }).then(tabs => Promise.all(tabs.map(tab => browser.tabs.sendMessage(tab.id, {
        hideSpinner: hide
    }).catch(() => {})))).catch(() => {})
}