const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = name => fs.readFileSync(path.join(__dirname, '../src', name), 'utf8')
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

function event() {
    const listeners = new Set()
    return {
        addListener: fn => listeners.add(fn),
        removeListener: fn => listeners.delete(fn),
        emit: value => [...listeners].forEach(fn => fn(value)),
        listeners
    }
}

function harness(settings = {}) {
    const downloads = [], workers = [], videos = [], canvases = [], revoked = [], timers = new Map()
    const changed = event(), erased = event()
    let timerId = 0
    class FakeURL extends URL {
        static createObjectURL() { return 'blob:test-' + downloads.length }
        static revokeObjectURL(url) { revoked.push(url) }
    }
    class Worker {
        constructor() { this.messages = []; this.terminated = false; workers.push(this) }
        postMessage(data, transfer) { this.messages.push({ data, transfer }) }
        terminate() { this.terminated = true }
        reply(data) { if (this.onmessage) this.onmessage({ data }) }
    }
    const browser = {
        runtime: { onMessage: event() },
        storage: { sync: { get: async defaults => ({ ...defaults, ...settings }) } },
        downloads: {
            onChanged: changed, onErased: erased,
            download: async options => {
                downloads.push({ ...options, id: downloads.length + 1, state: 'in_progress' })
                return downloads.length
            },
            search: async ({ id }) => downloads.filter(d => d.id === id)
        },
        tabs: { query: async () => [], sendMessage: async () => {} }
    }
    const context = vm.createContext({
        browser, URL: FakeURL, Blob, Uint8Array, ArrayBuffer, Worker, console,
        setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id },
        clearTimeout(id) { timers.delete(id) },
        document: { createElement(type) {
            if (type === 'canvas') {
                const drawing = {
                    drawImage() {}, getImageData: () => ({ data: new Uint8Array(4) })
                }
                const canvas = { width: 0, height: 0, getContext: () => drawing }
                canvases.push(canvas)
                return canvas
            }
            const video = {
                videoWidth: 1, videoHeight: 1, duration: 0.132, currentTime: 0,
                pause() { this.paused = true },
                removeAttribute(name) { delete this[name] }, load() {}
            }
            videos.push(video)
            return video
        } }
    })
    vm.runInContext(source('twitter_video_downloader.js'), context)
    vm.runInContext(source('twitter_video_assist_server.js'), context)
    function complete(id, state = 'complete') {
        downloads.find(d => d.id === id).state = state
        changed.emit({ id, state: { current: state } })
    }
    return { context, browser, downloads, workers, videos, canvases, revoked, timers, changed, erased, complete }
}

test('duplicate requests share work until completion, then allow re-download', async () => {
    const h = harness()
    const request = { type: 'video', url: 'https://video.twimg.com/a.mp4?tag=1' }
    const first = h.context.processRequest(request)
    const second = h.context.processRequest({ ...request, url: request.url.replace('tag=1', 'tag=2') })
    await flush()
    assert.equal(h.downloads.length, 1)
    h.complete(1)
    await Promise.all([first, second])
    const third = h.context.processRequest(request)
    await flush()
    assert.equal(h.downloads.length, 2)
    h.complete(2)
    await third
    assert.equal(h.changed.listeners.size, 0)
})

test('Blob URLs survive download initiation and are revoked on completion or interruption', async () => {
    for (const state of ['complete', 'interrupted']) {
        const h = harness()
        const result = h.context.downloadTsVideo(new Uint8Array([1]), 'sample', 'sample')
        const outcome = Promise.resolve(result).catch(error => error)
        await flush()
        assert.equal(h.revoked.length, 0)
        h.complete(1, state)
        await outcome
        assert.equal(h.revoked.length, 1)
        assert.equal(h.changed.listeners.size, 0)
        assert.equal(h.erased.listeners.size, 0)
    }
})

test('failed download initiation releases Blob and listeners', async () => {
    const h = harness()
    h.browser.downloads.download = async () => { throw new Error('cancelled') }
    await assert.rejects(h.context.downloadTsVideo(new Uint8Array([1]), 'a', 'a'), /cancelled/)
    assert.equal(h.revoked.length, 1)
    assert.equal(h.changed.listeners.size, 0)
})

test('completion before download ID is returned is reconciled by search', async () => {
    const h = harness()
    const original = h.browser.downloads.download
    h.browser.downloads.download = async options => {
        const id = await original(options)
        h.complete(id)
        return id
    }
    await h.context.downloadTsVideo(new Uint8Array([1]), 'a', 'a')
    assert.equal(h.revoked.length, 1)
})

test('same-basename GIFs own separate workers; repeated readiness and results are harmless', async () => {
    const h = harness()
    const first = h.context.convertGif('https://video.twimg.com/one/a.mp4', 'one')
    const second = h.context.convertGif('https://video.twimg.com/two/a.mp4', 'two')
    const ready = h.videos[0].onloadeddata
    ready(); ready()
    assert.equal(h.workers[0].messages.length, 1)
    const reply = h.workers[0].onmessage
    h.workers[0].reply({ type: 'ready' })
    assert.equal(h.workers[0].messages.at(-1).data.type, 'frame')
    assert.equal(h.workers[0].messages.at(-1).transfer.length, 1)
    assert.equal(h.workers[0].messages.length, 2)
    h.workers[0].reply({ type: 'frame' })
    h.videos[0].onseeked()
    h.workers[0].reply({ type: 'frame' })
    assert.equal(h.workers[0].messages.at(-1).data.type, 'finish')
    reply({ data: { type: 'finished', buffer: new Uint8Array([71, 73, 70]).buffer } })
    reply({ data: { type: 'finished', buffer: new Uint8Array([71, 73, 70]).buffer } })
    await flush()
    assert.equal(h.downloads.length, 1)
    assert.equal(h.workers[0].terminated, true)
    assert.equal(h.workers[1].terminated, false)
    assert.equal(h.videos[0].src, undefined)
    assert.equal(h.canvases[0].width, 0)
    h.complete(1)
    await first
    const failure = assert.rejects(second, /video/i)
    h.videos[1].onerror()
    await failure
    assert.equal(h.workers[1].terminated, true)
    assert.equal(h.timers.size, 0)
})

test('GIF load timeout and worker error release all conversion resources', async () => {
    for (const failure of ['timeout', 'worker']) {
        const h = harness()
        const result = h.context.convertGif('https://video.twimg.com/a.mp4', 'a')
        const rejected = assert.rejects(result)
        if (failure === 'timeout') [...h.timers.values()][0].fn()
        else h.workers[0].onerror({ message: 'encoder failed', preventDefault() {} })
        await rejected
        assert.equal(h.workers[0].terminated, true)
        assert.equal(h.videos[0].src, undefined)
        assert.equal(h.timers.size, 0)
        assert.equal(h.downloads.length, 0)
    }
})

test('GIF defaults still run both formats and wait for both', async () => {
    const h = harness()
    let finishGif, conversions = 0
    h.context.convertGif = () => { conversions++; return new Promise(resolve => { finishGif = resolve }) }
    const result = h.context.processRequest({ type: 'gif', url: 'https://video.twimg.com/a.mp4' })
    h.context.processRequest({ type: 'gif', url: 'https://video.twimg.com/a.mp4' })
    await flush()
    assert.equal(conversions, 1)
    assert.equal(h.downloads.length, 1)
    h.complete(1)
    finishGif()
    await result
})

test('one click deduplicates cached media without losing distinct attachments', async () => {
    const h = harness()
    const media = { tweetId: '123', type: 'video', url: 'https://video.twimg.com/a.mp4?tag=1' }
    const sent = []
    Object.assign(h.context, {
        sessionStorage: { getItem: () => JSON.stringify([media, { ...media, url: media.url.replace('1', '2') }, { ...media, url: 'https://video.twimg.com/b.mp4' }]) },
        $: () => ({ closest: () => ({}) }), extractMainTweetId: () => '123'
    })
    h.browser.runtime.sendMessage = async media => sent.push(media)
    const text = source('twitter_video_assist_client.js')
    vm.runInContext(text.slice(text.indexOf('async function downloadMediaObject('), text.indexOf('async function downloadVideoObject(')), h.context)
    await h.context.downloadMediaObject({ stopPropagation() {}, preventDefault() {}, data: 'article' })
    assert.equal(sent.length, 2)
})

test('download failures unlock requests for retry and ignore unrelated messages', async () => {
    const h = harness()
    assert.equal(h.context.processRequest({ type: 'UPDATE_SESSION_DATA' }), undefined)
    assert.match((await h.context.processRequest({ type: 'video', url: 'invalid' })).error, /URL/)
    const download = h.browser.downloads.download
    h.browser.downloads.download = async () => { throw new Error('cancelled') }
    const request = { type: 'video', url: 'https://video.twimg.com/a.mp4' }
    assert.equal((await h.context.processRequest(request)).error, 'cancelled')
    h.browser.downloads.download = download
    const retry = h.context.processRequest(request)
    await flush()
    h.complete(1)
    assert.equal((await retry).success, true)
})

test('download removal releases Blob resources', async () => {
    const h = harness()
    const task = h.context.downloadTsVideo(new Uint8Array([1]), 'a', 'a')
    const failure = assert.rejects(task, /removed/)
    await flush()
    h.erased.emit(1)
    await failure
    assert.equal(h.revoked.length, 1)
    assert.equal(h.changed.listeners.size, 0)
})

test('images preserve format and readable filenames without a global rename listener', async () => {
    for (const readableName of [false, true]) {
        const h = harness({ readableName, spcificPathName: true })
        const url = h.context.refineImageSourceParams('https://pbs.twimg.com/media/photo?format=png&name=small')
        assert.equal(url, 'https://pbs.twimg.com/media/photo?format=png&name=orig')
        const task = h.context.downloadImage({ url, readableFilename: 'owner-tweet-1' })
        await flush()
        assert.equal(h.downloads[0].filename, readableName ? 'owner-tweet-1.png' : 'photo.png')
        assert.equal(h.downloads[0].saveAs, true)
        h.complete(1)
        await task
    }
})

test('GIF settings still support either output alone or neither output', async () => {
    for (const [isConvertGIF, isSaveMP4] of [[true, false], [false, true], [false, false]]) {
        const h = harness({ isConvertGIF, isSaveMP4 })
        let conversions = 0
        h.context.convertGif = async () => { conversions++ }
        const task = h.context.processGifVideo({ url: 'https://video.twimg.com/a.mp4' })
        await flush()
        assert.equal(conversions, Number(isConvertGIF))
        assert.equal(h.downloads.length, Number(isSaveMP4))
        if (isSaveMP4) h.complete(1)
        await task
    }
})

test('a failing GIF output does not unlock the request while the MP4 is active', async () => {
    const h = harness()
    let conversions = 0
    h.context.convertGif = async () => { conversions++; throw new Error('conversion failed') }
    const request = { type: 'gif', url: 'https://video.twimg.com/a.mp4' }
    const task = h.context.processRequest(request)
    await flush()
    assert.equal(h.context.processRequest(request), task)
    assert.equal(conversions, 1)
    h.complete(1)
    assert.equal((await task).error, 'conversion failed')
})

test('GIF invalid media, drawing errors, message errors and stalled seeks clean up', async () => {
    for (const failure of ['duration', 'canvas', 'message', 'seek']) {
        const h = harness()
        const task = h.context.convertGif('https://video.twimg.com/a.mp4', 'a')
        const rejected = assert.rejects(task)
        if (failure === 'duration') h.videos[0].duration = Infinity
        h.videos[0].onloadeddata()
        if (failure === 'message') h.workers[0].onmessageerror()
        if (failure === 'canvas') {
            h.canvases[0].getContext().getImageData = () => { throw new Error('tainted canvas') }
            h.workers[0].reply({ type: 'ready' })
        }
        if (failure === 'seek') {
            h.workers[0].reply({ type: 'ready' })
            h.workers[0].reply({ type: 'frame' })
            assert.equal(h.workers[0].messages.length, 2)
            assert.equal(h.videos[0].currentTime, 0.066)
            h.timers.values().next().value.fn()
        }
        await rejected
        assert.equal(h.workers[0].terminated, true)
        assert.equal(h.timers.size, 0)
    }
})

function gifWorker() {
    const messages = []
    let listener, closed = false
    const context = vm.createContext({
        Uint8Array,
        self: {
            addEventListener(type, fn) { listener = fn },
            postMessage(data, transfer) { messages.push({ data, transfer }) },
            close() { closed = true }
        },
        importScripts(...names) { names.forEach(name => vm.runInContext(source(name), context)) }
    })
    vm.runInContext(source('gif_converter.js'), context)
    return { messages, send: data => listener({ data }), closed: () => closed }
}

test('real bundled encoder transfers one valid GIF and ignores repeated finish', () => {
    const worker = gifWorker()
    worker.send({ type: 'start', delay: 66, w: 2, h: 2 })
    for (const color of [[255, 0, 0, 255], [0, 255, 0, 255]]) {
        worker.send({ type: 'frame', buffer: new Uint8Array([...color, ...color, ...color, ...color]).buffer })
    }
    worker.send({ type: 'finish' })
    worker.send({ type: 'finish' })
    const finished = worker.messages.filter(m => m.data.type === 'finished')
    assert.equal(finished.length, 1)
    const bytes = Buffer.from(finished[0].data.buffer)
    assert.equal(bytes.subarray(0, 6).toString(), 'GIF89a')
    assert.equal(bytes.at(-1), 0x3b)
    assert.equal(finished[0].transfer[0], finished[0].data.buffer)
    assert.equal(worker.closed(), true)
})

test('real worker closes on invalid protocol input instead of hanging', () => {
    const worker = gifWorker()
    worker.send({ type: 'frame', buffer: new Uint8Array(4).buffer })
    assert.equal(worker.messages[0].data.type, 'error')
    assert.equal(worker.closed(), true)
    worker.send({ type: 'finish' })
    assert.equal(worker.messages.length, 1)
})

test('GIF storage failure after encoding rejects without retaining its worker or allocating a URL', async () => {
    const h = harness()
    const task = h.context.convertGif('https://video.twimg.com/a.mp4', 'a')
    const rejected = assert.rejects(task, /storage failed/)
    h.videos[0].duration = 0.01
    h.videos[0].onloadeddata()
    h.workers[0].reply({ type: 'ready' })
    h.workers[0].reply({ type: 'frame' })
    h.browser.storage.sync.get = () => { throw new Error('storage failed') }
    h.workers[0].reply({ type: 'finished', buffer: new Uint8Array([1]).buffer })
    await rejected
    assert.equal(h.workers[0].terminated, true)
    assert.equal(h.timers.size, 0)
    assert.equal(h.downloads.length, 0)
})

test('encoder construction failure rejects without a pending conversion', async () => {
    const h = harness()
    h.context.Worker = class { constructor() { throw new Error('worker unavailable') } }
    await assert.rejects(h.context.convertGif('https://video.twimg.com/a.mp4', 'a'), /unavailable/)
    assert.equal(h.timers.size, 0)
    assert.equal(h.videos.length, 0)
})

test('GIF output decodes to two distinct frames with FFmpeg when available', t => {
    const { spawnSync } = require('node:child_process')
    const probe = spawnSync('ffmpeg', ['-version'], { timeout: 5000 })
    if (probe.error?.code === 'ENOENT') return t.skip('FFmpeg is not installed')
    assert.equal(probe.status, 0)
    const worker = gifWorker()
    worker.send({ type: 'start', delay: 66, w: 2, h: 2 })
    for (const color of [[255, 0, 0, 255], [0, 255, 0, 255]]) {
        worker.send({ type: 'frame', buffer: new Uint8Array([...color, ...color, ...color, ...color]).buffer })
    }
    worker.send({ type: 'finish' })
    const result = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], {
        input: Buffer.from(worker.messages.at(-1).data.buffer), timeout: 10000, maxBuffer: 1024 * 1024
    })
    assert.equal(result.status, 0, result.stderr?.toString())
    assert.equal(result.stdout.length, 24)
    assert.ok(result.stdout[0] > result.stdout[1])
    assert.ok(result.stdout[13] > result.stdout[12])
})