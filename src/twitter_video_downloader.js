const activeDownloads = new Map()

function mediaKey(media) {
    const url = new URL(media.url)
    url.hash = ''
    // Delivery tags and image sizes do not identify different attachments.
    if (url.hostname === 'video.twimg.com' || url.hostname === 'pbs.twimg.com') {
        for (const name of ['tag', 'name']) url.searchParams.delete(name)
    }
    url.searchParams.sort()
    return `${media.type}:${url.href}`
}

function downloadFile(options, objectUrl = false) {
    return new Promise((resolve, reject) => {
        let id
        let settled = false
        function finish(error) {
            if (settled) return
            settled = true
            browser.downloads.onChanged.removeListener(onChanged)
            browser.downloads.onErased.removeListener(onErased)
            if (objectUrl) URL.revokeObjectURL(options.url)
            if (error) reject(error)
            else resolve(id)
        }
        function onChanged(delta) {
            if (id === undefined || delta.id !== id) return
            if (delta.state?.current === 'complete') finish()
            else if (delta.state?.current === 'interrupted') finish(new Error('Download interrupted'))
        }
        function onErased(erasedId) {
            if (id !== undefined && erasedId === id) finish(new Error('Download removed'))
        }
        browser.downloads.onChanged.addListener(onChanged)
        browser.downloads.onErased.addListener(onErased)
        Promise.resolve().then(() => browser.downloads.download(options)).then(downloadId => {
            id = downloadId
            // A small download can finish before download() resolves with its ID.
            return browser.downloads.search({ id })
        }).then(items => {
            if (!items.length) finish(new Error('Download removed'))
            else onChanged({ id, state: { current: items[0].state } })
        }).catch(finish)
    })
}

function downloadMediaFile(media, makeOptions) {
    const key = mediaKey(media)
    if (activeDownloads.has(key)) return activeDownloads.get(key)
    const task = Promise.resolve().then(makeOptions).then(options => downloadFile(options))
        .finally(() => activeDownloads.delete(key))
    activeDownloads.set(key, task)
    return task
}

function processBlobVideo(id, readableName, token) {
    browser.storage.sync.get({
        isVideoSaveAsTS: true,
        isVideoSaveAsMP4: true,
    }).then((items) => {
        if (items.isVideoSaveAsTS) {
            processComplexTsVideo(id, readableName, token)
        }

        if (items.isVideoSaveAsMP4) {
            processComplexMp4Video(id, readableName, token)
        }
    })
}

function processGifVideo({ url, readableFilename }) {
    return browser.storage.sync.get({
        isConvertGIF: true,
        isSaveMP4: true,
    }).then((items) => {
        const tasks = []
        if (items.isConvertGIF) tasks.push(convertGif(url, readableFilename))
        if (items.isSaveMP4) tasks.push(downloadMp4Video({ url, readableFilename }))
        // Keep the request locked until both outputs settle, even if one fails.
        return Promise.all(tasks.map(task => task.then(() => null, error => error))).then(errors => {
            const error = errors.find(Boolean)
            if (error) throw error
        })
    })
}

async function processComplexTsVideo(id, readableName, token) {
    var jsonUrl = "https://api.twitter.com/1.1/videos/tweet/config/"
    jsonUrl += id + ".json"

    var playlistUrl = await getPlaylistUrl(jsonUrl, token)
    var filename = playlistUrl.substring(playlistUrl.lastIndexOf('/') + 1).split(".")[0]
    var palylist = await getMaximumBandwidthPlaylist(playlistUrl)
    var videoUrls = await getVideoFileUrls(palylist)
    var videoData = await accumTsFragment(videoUrls)

    downloadTsVideo(videoData, filename, readableName)
}

async function extractGraphQlMp4Video(id, token, index) {
    try {
        const jsonResponse = await archiveTweetDetailJson(id, token)
        const tweetResults = jsonResponse["data"]["threaded_conversation_with_injections_v2"]["instructions"][0]["entries"][0]["content"]["itemContent"]["tweet_results"]["result"]

        let videoSources = null
        if (tweetResults.hasOwnProperty('tweet')) {
            videoSources = tweetResults['tweet']["legacy"]["extended_entities"]["media"][index]["video_info"]["variants"]
        } else {
            videoSources = tweetResults["legacy"]["extended_entities"]["media"][index]["video_info"]["variants"]
        }
        videoSources.sort(sortByBitrate)

        return videoSources[0]['url']
    } catch (e) {
        if (e instanceof TypeError) {
            return null
        } else {
            throw e;
        }
    }
}

function getMaximumBitrate(videoSources) {
    videoSources.sort(sortByBitrate)
    return videoSources[0]['url']
}

function refineImageSourceParams(src) {
    const url = new URL(src);
    const searchParams = url.searchParams;
    searchParams.set('name', 'orig')
    url.search = searchParams

    return url.toString()
}

function extractMedias(tweets) {
    const mediaMap = {};

    tweets.forEach(tweet => {
        const mediaArr = tweet?.legacy?.extended_entities?.media;
        if (!mediaArr) return;

        const screenName = tweet.core?.user_results?.result?.core?.screen_name || 'unknown';
        const tweetId = tweet.legacy.id_str;

        mediaMap[tweetId] = mediaArr.map((media, index) => ({
            ...media,
            readableFilename: mediaArr.length === 1 
                ? `${screenName}-${tweetId}` 
                : `${screenName}-${tweetId}-${index + 1}`,
            tweetId,
            referencedBy: tweet.referencedBy
        }));
    });
    
    const medias = Object.values(mediaMap).flat().map(media => {
        let url, type;
        if (media.type === 'photo') {
            type = 'image';
            url = refineImageSourceParams(media.media_url_https);
        } else if (media.type === 'video') {
            type = 'video';
            url = getMaximumBitrate(media.video_info.variants);
        } else if (media.type === 'animated_gif') {
            type = 'gif';
            url = getMaximumBitrate(media.video_info.variants);
        } else {
            return null;
        }
        return {
            type,
            url,
            readableFilename: media.readableFilename,
            tweetId: media.tweetId,
            referencedBy: media.referencedBy
        };
    }).filter(Boolean);

    return medias;
}

async function extractGraphQlMedia(id, token) {
    try {
        const jsonResponse = await archiveTweetDetailJson(id, token)
        const tweetResults = jsonResponse["data"]["threaded_conversation_with_injections_v2"]["instructions"][0]["entries"]
        const targetTweet = tweetResults.find((tweet) => tweet.entryId.includes(id))["content"]["itemContent"]["tweet_results"]["result"];

        let tweets = [targetTweet]

        if (targetTweet.hasOwnProperty('quoted_status_result')) {
            tweets.push(targetTweet['quoted_status_result']['result'])
        }

        tweets = tweets.map(tweet => {
            return !!tweet.tweet ? tweet.tweet : tweet
        })

        const medias = tweets.filter(tweet => !!tweet?.legacy?.extended_entities?.media).map(tweet => {
            const screenName = tweet.core.user_results.result.legacy.screen_name
            const tweetId = tweet.legacy.id_str
            const medias = tweet.legacy.extended_entities.media

            return medias.map((media, index) => {
                const filename = medias.length === 1
                    ? `${screenName}-${tweetId}`
                    : `${screenName}-${tweetId}-${index + 1}`


                return {
                    ...media,
                    readableFilename: filename
                }
            })

        }).flat()

        return medias.map((media) => {
            let url = null
            if (media.type == 'photo') {
                return { type: 'image', url: refineImageSourceParams(media.media_url_https), readableFilename: media.readableFilename }
            } else if (media.type == 'video') {
                return { type: 'video', url: getMaximumBitrate(media.video_info.variants), readableFilename: media.readableFilename }
            } else if (media.type == 'animated_gif') {
                return { type: 'gif', url: getMaximumBitrate(media.video_info.variants), readableFilename: media.readableFilename }
            }
        })
    } catch (e) {
        throw e
    }
}

async function archiveTweetDetailJson(id, token) {
    let tweetDetailUrl = `https://${window.location.hostname}/i/api/graphql/-Ls3CrSQNo2fRKH6i6Na1A/TweetDetail?variables=%7B%22focalTweetId%22%3A%22${id}%22%2C%22with_rux_injections%22%3Afalse%2C%22includePromotedContent%22%3Atrue%2C%22withCommunity%22%3Atrue%2C%22withQuickPromoteEligibilityTweetFields%22%3Atrue%2C%22withBirdwatchNotes%22%3Atrue%2C%22withVoice%22%3Atrue%2C%22withV2Timeline%22%3Atrue%7D&features=%7B%22rweb_lists_timeline_redesign_enabled%22%3Atrue%2C%22responsive_web_graphql_exclude_directive_enabled%22%3Atrue%2C%22verified_phone_label_enabled%22%3Afalse%2C%22creator_subscriptions_tweet_preview_api_enabled%22%3Atrue%2C%22responsive_web_graphql_timeline_navigation_enabled%22%3Atrue%2C%22responsive_web_graphql_skip_user_profile_image_extensions_enabled%22%3Afalse%2C%22tweetypie_unmention_optimization_enabled%22%3Atrue%2C%22responsive_web_edit_tweet_api_enabled%22%3Atrue%2C%22graphql_is_translatable_rweb_tweet_is_translatable_enabled%22%3Atrue%2C%22view_counts_everywhere_api_enabled%22%3Atrue%2C%22longform_notetweets_consumption_enabled%22%3Atrue%2C%22responsive_web_twitter_article_tweet_consumption_enabled%22%3Afalse%2C%22tweet_awards_web_tipping_enabled%22%3Afalse%2C%22freedom_of_speech_not_reach_fetch_enabled%22%3Atrue%2C%22standardized_nudges_misinfo%22%3Atrue%2C%22tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled%22%3Atrue%2C%22longform_notetweets_rich_text_read_enabled%22%3Atrue%2C%22longform_notetweets_inline_media_enabled%22%3Atrue%2C%22responsive_web_media_download_video_enabled%22%3Afalse%2C%22responsive_web_enhance_cards_enabled%22%3Afalse%7D&fieldToggles=%7B%22withAuxiliaryUserLabels%22%3Afalse%2C%22withArticleRichContentState%22%3Afalse%7D`

    const response = await fetch(tweetDetailUrl, {
        "credentials": "include",
        "headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0",
            "Accept": "*/*",
            "Accept-Language": "ko-KR,ko;q=0.8,en-US;q=0.5,en;q=0.3",
            "content-type": "application/json",
            "x-twitter-auth-type": "OAuth2Session",
            "x-csrf-token": token,
            "x-twitter-client-language": "ko",
            "x-twitter-active-user": "yes",
            "X-Client-Transaction-Id": "NzRMqdd3tuyaOaNVwIUt8B2lkDXpa9LFoDd8b4qm19wGAPlc5MmznuiuWvZwPq1lzUQZYgAE+nthOir1ViJ1D9Sjz59h",
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin",
            "authorization": "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"
        },
        "referrer": "https://twitter.com/Sanghai83780Kim/status/1679624508293140480",
        "method": "GET",
        "mode": "cors"
    });

    return await response.json()
}

const sortByBitrate = (a, b) => {
    const bitrateA = a.bitrate || 0;
    const bitrateB = b.bitrate || 0;

    return bitrateB - bitrateA;
}

async function processComplexMp4Video(id, readableName, token) {
    var pageUrl = "https://api.twitter.com/1.1/statuses/show.json?include_profile_interstitial_type=1&include_blocking=1&include_blocked_by=1&include_followed_by=1&include_want_retweets=1&include_mute_edge=1&include_can_dm=1&skip_status=1&cards_platform=Web-12&include_cards=1&include_ext_alt_text=true&include_reply_count=1&tweet_mode=extended&trim_user=false&include_ext_media_color=true&id=" + id
    var mp4Url = await getMp4Url(pageUrl, token)

    downloadMp4Video(mp4Url, readableName)
}

function processImageDownload(src, readableName) {
    browser.runtime.sendMessage({
        type: 'image',
        readableName: readableName,
        url: src
    })
}

function getMp4Url(url, token) {
    return new Promise((resolve, reject) => {
        var init = {
            origin: 'https://mobile.twitter.com',
            headers: {
                "Accept": '*/*',
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:62.0) Gecko/20100101 Firefox/62.0",
                "authorization": "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA",
                "x-csrf-token": token,
            },
            credentials: 'include',
            referrer: 'https://mobile.twitter.com'
        }

        fetch(url, init)
            .then((response) => {
                if (response.status == 200) {
                    response.json().then((json) => {
                        let mp4Variants = (json.extended_entities || json.quoted_status.extended_entities).media[0].video_info.variants.filter(variant => variant.content_type === 'video/mp4')
                        mp4Variants = mp4Variants.sort((a, b) => (b.bitrate - a.bitrate))

                        let url = ''
                        if (mp4Variants.length) {
                            url = mp4Variants[0].url
                        }
                        resolve(url)
                    })
                } else {
                    reject({
                        status: response.status,
                        statusText: response.statusText
                    })
                }
            })
            .catch((err) => {
                reject({
                    error: err
                })
            })
    })
}

function getPlaylistUrl(url, token) {
    return new Promise((resolve, reject) => {
        var init = {
            method: 'GET',
            mode: 'cors',
            origin: 'https://twitter.com',
            headers: {
                "Accept": '*/*',
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:62.0) Gecko/20100101 Firefox/62.0",
                "authorization": "Bearer AAAAAAAAAAAAAAAAAAAAAPYXBAAAAAAACLXUNDekMxqa8h%2F40K4moUkGsoc%3DTYfbDKbT3jJPCEVnMYqilB28NHfOPqkca3qaAxGfsyKCs0wRbw",
                "x-csrf-token": token,
            },
            credentials: 'include',
            referrer: 'https://twitter.com'
        }

        fetch(url, init)
            .then((response) => {
                if (response.status == 200) {
                    response.json().then((data) => {
                        var platlistUrl = data["track"]["playbackUrl"]
                        resolve(platlistUrl)
                    })
                } else {
                    reject({
                        status: response.status,
                        statusText: response.statusText
                    })
                }
            })
            .catch((err) => {
                reject({
                    error: err
                })
            })
    })
}

function getMaximumBandwidthPlaylist(url) {
    return new Promise((resolve, reject) => {
        fetch(url)
            .then(
                (response) => {
                    if (response.status == 200) {
                        response.text().then((text) => {
                            resolve(findMaxBandwidthSource(text))
                        })
                    } else {
                        reject({
                            status: response.status,
                            statusText: response.statusText
                        })
                    }
                }
            )
            .catch((err) => {
                reject({
                    error: err
                })
            })
    })
}

function getVideoFileUrls(url) {
    return new Promise((resolve, reject) => {
        fetch(url)
            .then(
                (response) => {
                    if (response.status == 200) {
                        response.text().then((text) => {
                            resolve(parseVideoUrls(text))
                        })
                    } else {
                        reject({
                            status: response.status,
                            statusText: response.statusText
                        })
                    }
                }
            )
            .catch((err) => {
                reject({
                    error: err
                })
            })
    })

}

async function accumTsFragment(videoUrls) {
    var videoBuffer = new Uint8Array(0)

    for (var i in videoUrls) {
        var fragment = await downloadTsFragment(videoUrls[i])
        videoBuffer = mergeFragment(videoBuffer, fragment)
    }

    return videoBuffer
}

function downloadTsFragment(urlTs) {
    return new Promise((resolve, reject) => {
        fetch(urlTs)
            .then((response) => response.arrayBuffer())
            .then((buffer) => {
                resolve(buffer)
            })
            .catch((err) => {
                reject({
                    error: err
                })
            })
    })
}

function mergeFragment(buffer, fragment) {
    var now = new Uint8Array(fragment)
    var prev = new Uint8Array(buffer)

    var merged = new Uint8Array(now.length + prev.length)
    merged.set(prev)
    merged.set(now, prev.length)

    return merged
}

function downloadTsVideo(data, tsFilename, readableName) {
    return browser.storage.sync.get({
        spcificPathName: false,
        readableName: false
    }).then((items) => {
        var blob = new Blob([data], {
            type: 'video/mp2t'
        })
        var url = URL.createObjectURL(blob)

        let options = {
            url: url,
            saveAs: items.spcificPathName,
            filename: tsFilename + ".ts"
        }

        if (items.readableName) {
            options.filename = readableName + '.ts'
        }

        return downloadFile(options, true)
    })
}

function fileExtension(url) {
    const splited = url.split('.')
    return splited[splited.length - 1].split('?')[0]
}

function downloadMp4Video({ url, readableFilename }) {
    return downloadMediaFile({ type: 'video', url }, () => browser.storage.sync.get({
        spcificPathName: false,
        readableName: false
    }).then((items) => {
        let options = {
            url: url,
            saveAs: items.spcificPathName
        }

        if (items.readableName) {
            options.filename = readableFilename + '.' + fileExtension(url)
        }

        return options
    }))
}

function downloadImage({ url, readableFilename }) {
    return downloadMediaFile({ type: 'image', url }, () => browser.storage.sync.get({
        spcificPathName: false,
        readableName: false
    }).then((items) => {
        const source = new URL(url)
        const basename = source.pathname.substring(source.pathname.lastIndexOf('/') + 1)
        const match = /^(.*)\.(\w{2,4})$/.exec(basename)
        const format = source.searchParams.get('format') || (match ? match[2] : 'jpg')
        const filename = items.readableName ? readableFilename : (match ? match[1] : basename)
        return {
            url: url,
            saveAs: items.spcificPathName,
            filename: `${filename}.${format}`
        }
    }))
}

function getCookie(cname) {
    var name = cname + "="
    var decodedCookie = decodeURIComponent(document.cookie)
    var ca = decodedCookie.split(';')
    for (var i = 0; i < ca.length; i++) {
        var c = ca[i]
        while (c.charAt(0) == ' ') {
            c = c.substring(1)
        }
        if (c.indexOf(name) == 0) {
            return c.substring(name.length, c.length)
        }
    }
    return ""
}

function findMaxBandwidthSource(string) {
    var stringsSplited = string.split("#")
    var arrBandwidth = []
    for (var i in stringsSplited) {
        var bandwidth = findBandwidth(stringsSplited[i])
        if (bandwidth > 0) {
            arrBandwidth.push(bandwidth)
        }
    }

    var bandwidthMax = Math.max.apply(null, arrBandwidth)
    for (var i in stringsSplited) {
        if (bandwidthMax == findBandwidth(stringsSplited[i])) {
            return findPlaylistSource(stringsSplited[i])
        }
    }
    return ""
}

function findBandwidth(sourcePlaylist) {
    var stringsSplited = sourcePlaylist.split(/:|,/)
    for (var i in stringsSplited) {
        if (stringsSplited[i].search("BANDWIDTH") == 0) {
            return Number(stringsSplited[i].split("=")[1])
        }
    }
    return -1
}

function findPlaylistSource(sourcePlaylist) {
    var stringsSplited = sourcePlaylist.split("\n")
    for (var i in stringsSplited) {
        if (((stringsSplited[i].search("ext_tw_video") > 0) || (stringsSplited[i].search("amplify_video") > 0)) && (stringsSplited[i].search("m3u8") > 0)) {
            return "https://video.twimg.com" + stringsSplited[i]
        }
    }
    return ""
}

function parseVideoUrls(string) {
    var stringsSplited = string.split("#")
    var arrPlaylist = []
    for (var i in stringsSplited) {
        if ((stringsSplited[i].search("ext_tw_video") > 0) || (stringsSplited[i].search("amplify_video") > 0)) {
            arrPlaylist.push("https://video.twimg.com" + stringsSplited[i].split("\n")[1])
        }
    }
    return arrPlaylist
}
