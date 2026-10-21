importScripts('jsgif/LZWEncoder.js', 'jsgif/NeuQuant.js', 'jsgif/GIFEncoder.js');

let encoder = null
let finished = false

self.addEventListener('message', function (event) {
    if (finished) return
    try {
        const message = event.data
        if (message.type === 'start') {
            if (encoder) throw new Error('GIF encoder already started')
            encoder = new GIFEncoder()
            encoder.setRepeat(0)
            encoder.setDelay(message.delay)
            encoder.setSize(message.w, message.h)
            if (!encoder.start()) throw new Error('GIF encoder failed to start')
            self.postMessage({ type: 'ready' })
        } else if (message.type === 'frame') {
            if (!encoder || !encoder.addFrame(new Uint8Array(message.buffer), true)) {
                throw new Error('GIF frame encoding failed')
            }
            self.postMessage({ type: 'frame' })
        } else if (message.type === 'finish') {
            if (!encoder || !encoder.finish()) throw new Error('GIF encoding failed to finish')
            finished = true
            const bytes = new Uint8Array(encoder.stream().bin)
            encoder = null
            self.postMessage({ type: 'finished', buffer: bytes.buffer }, [bytes.buffer])
            self.close()
        } else {
            throw new Error('Unknown GIF worker message')
        }
    } catch (error) {
        finished = true
        encoder = null
        self.postMessage({ type: 'error', error: error.message })
        self.close()
    }
}, false)