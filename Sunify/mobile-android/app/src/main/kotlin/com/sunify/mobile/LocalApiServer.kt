package com.sunify.mobile

import android.content.Context
import fi.iki.elonen.NanoHTTPD
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class LocalApiServer(
    private val context: Context,
    private val audioService: YouTubeAudioService,
    port: Int = 3001
) : NanoHTTPD("127.0.0.1", port) {

    private fun jsonResponse(status: Response.Status, body: JSONObject): Response {
        return newFixedLengthResponse(status, "application/json; charset=utf-8", body.toString()).apply {
            addHeader("Access-Control-Allow-Origin", "*")
            addHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
            addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        }
    }

    private fun errorResponse(status: Response.Status, msg: String): Response =
        jsonResponse(status, JSONObject().put("error", msg))

    private fun readJsonBody(session: IHTTPSession): JSONObject {
        val files = HashMap<String, String>()
        runCatching { session.parseBody(files) }
        val raw = files["postData"].orEmpty()
        return runCatching { JSONObject(raw) }.getOrDefault(JSONObject())
    }

    override fun serve(session: IHTTPSession): Response {
        if (session.method == Method.OPTIONS) {
            return jsonResponse(Response.Status.OK, JSONObject().put("ok", true))
        }
        val uri = session.uri ?: "/"
        val params = session.parms ?: emptyMap()
        val authHeader = session.headers["authorization"].orEmpty()
        val bearer = authHeader.replace(Regex("^Bearer\\s+", RegexOption.IGNORE_CASE), "").trim()

        return try {
            when {
                uri == "/api/diagnostics" -> jsonResponse(
                    Response.Status.OK,
                    JSONObject().put("server", "ready").put("platform", "android")
                )

                uri == "/api/search" -> {
                    val q = params["q"].orEmpty().trim()
                    if (q.isEmpty()) return errorResponse(Response.Status.BAD_REQUEST, "Query is required")
                    val results = audioService.searchTracks(q)
                    jsonResponse(Response.Status.OK, JSONObject().put("results", JSONArray(results.map { it.toJson() })))
                }

                uri == "/api/search/playlists" -> {
                    val q = params["q"].orEmpty().trim()
                    if (q.isEmpty()) return errorResponse(Response.Status.BAD_REQUEST, "Query is required")
                    jsonResponse(Response.Status.OK, JSONObject().put("playlists", audioService.searchPlaylists(q)))
                }

                uri == "/api/import-playlist" -> {
                    val body = readJsonBody(session)
                    val url = body.optString("url").trim()
                    if (url.isEmpty()) return errorResponse(Response.Status.BAD_REQUEST, "URL gerekli.")
                    jsonResponse(Response.Status.OK, audioService.importPlaylist(url))
                }

                uri == "/api/recommendations" -> {
                    val tracks = audioService.getRecommendations(
                        seedsJson = params["seeds"],
                        query = params["q"],
                        modeParam = params["mode"],
                        excludeArtistsJson = params["excludeArtists"],
                        forceRefresh = params["refresh"] == "1"
                    )
                    jsonResponse(Response.Status.OK, JSONObject().put("tracks", JSONArray(tracks.map { it.toJson() })))
                }

                uri == "/api/daily-mix/artist-tracks" -> {
                    val tracks = audioService.getArtistMixTracks(params["artists"].orEmpty())
                    jsonResponse(Response.Status.OK, JSONObject().put("tracks", JSONArray(tracks.map { it.toJson() })))
                }

                uri == "/api/artists/search" -> {
                    val q = params["q"].orEmpty().trim()
                    jsonResponse(Response.Status.OK, JSONObject().put("artists", ArtistService.searchArtists(q)))
                }

                uri.startsWith("/api/artists/") -> {
                    val id = uri.removePrefix("/api/artists/").trim()
                    jsonResponse(Response.Status.OK, ArtistService.getArtistProfile(id))
                }

                uri == "/api/lyrics" -> {
                    val title = params["title"].orEmpty().trim()
                    val artist = params["artist"].orEmpty().trim()
                    val duration = params["duration"]?.toDoubleOrNull() ?: 0.0
                    val source = params["source"].orEmpty().ifEmpty { "auto" }
                    jsonResponse(Response.Status.OK, LyricsService.fetchLyrics(title, artist, duration, source))
                }

                uri == "/api/audio-stream" || uri == "/api/stream" -> handleAudioStream(session, params)

                uri == "/api/audio-ready" -> jsonResponse(
                    Response.Status.OK,
                    JSONObject().put("ready", true).put("progress", 100)
                )

                uri == "/api/audio-prefetch" -> {
                    val body = readJsonBody(session)
                    val target = body.optString("id").ifEmpty { body.optString("query") }
                    if (target.isNotBlank()) {
                        Thread {
                            runCatching {
                                audioService.resolveAudioStream(target, body.optString("title"), body.optString("artist"))
                            }
                        }.start()
                    }
                    jsonResponse(Response.Status.OK, JSONObject().put("queued", true))
                }

                uri == "/api/audio-cache" -> jsonResponse(Response.Status.OK, JSONObject().put("tracks", JSONArray()))

                uri == "/api/audio-cache/clear" -> {
                    var count = 0
                    var bytes = 0L
                    audioService.cacheDir.listFiles()?.forEach { f ->
                        bytes += f.length()
                        if (f.delete()) count++
                    }
                    jsonResponse(Response.Status.OK, JSONObject().put("success", true).put("files", count).put("bytes", bytes))
                }

                uri == "/api/local-downloads" -> {
                    val tracks = JSONArray()
                    audioService.downloadsDir.listFiles()?.filter { it.isFile }?.forEach { file ->
                        val base = file.nameWithoutExtension
                        val parts = base.split("_", limit = 2)
                        val artist = parts.getOrNull(0).orEmpty().ifEmpty { "Yerel" }
                        val title = parts.getOrNull(1).orEmpty().ifEmpty { base }
                        tracks.put(JSONObject().apply {
                            put("title", title)
                            put("artist", artist)
                            put("isLocal", true)
                            put("size", file.length())
                            put("localUrl", "/api/library/file?name=${java.net.URLEncoder.encode(file.name, "UTF-8")}")
                        })
                    }
                    jsonResponse(Response.Status.OK, JSONObject().put("tracks", tracks))
                }

                uri == "/api/library/file" -> {
                    val name = params["name"].orEmpty()
                    val file = File(audioService.downloadsDir, File(name).name)
                    if (!file.exists()) return errorResponse(Response.Status.NOT_FOUND, "Dosya bulunamadı.")
                    serveFileWithRange(session, file, "audio/mp4")
                }

                uri == "/api/save-track-locally" -> {
                    val body = readJsonBody(session)
                    val file = audioService.saveTrackLocally(
                        body.optString("id"),
                        body.optString("title"),
                        body.optString("artist"),
                        body.optString("query")
                    )
                    jsonResponse(
                        Response.Status.OK,
                        JSONObject()
                            .put("success", true)
                            .put("localUrl", "/api/library/file?name=${java.net.URLEncoder.encode(file.name, "UTF-8")}")
                    )
                }

                uri == "/api/storage/stats" -> {
                    val cacheBytes = audioService.cacheDir.listFiles()?.sumOf { it.length() } ?: 0L
                    val dlBytes = audioService.downloadsDir.listFiles()?.sumOf { it.length() } ?: 0L
                    jsonResponse(
                        Response.Status.OK,
                        JSONObject()
                            .put("audioCacheBytes", cacheBytes)
                            .put("downloadsBytes", dlBytes)
                            .put("localMusicBytes", 0L)
                            .put("audioCacheLimitBytes", audioService.cacheLimitBytes)
                    )
                }

                uri == "/api/storage/settings" -> {
                    val body = readJsonBody(session)
                    val dlGb = body.optDouble("downloadLimitGB", 5.0)
                    val cacheGb = body.optDouble("cacheLimitGB", 0.5)
                    audioService.downloadLimitBytes = if (dlGb <= 0) 0L else (dlGb * 1024 * 1024 * 1024).toLong()
                    audioService.cacheLimitBytes = if (cacheGb <= 0) 0L else (cacheGb * 1024 * 1024 * 1024).toLong()
                    jsonResponse(Response.Status.OK, JSONObject().put("success", true))
                }

                uri == "/api/auth/login" -> {
                    val body = readJsonBody(session)
                    jsonResponse(Response.Status.OK, SupabaseSyncService.login(body.optString("email"), body.optString("password")))
                }

                uri == "/api/auth/register" -> {
                    val body = readJsonBody(session)
                    jsonResponse(
                        Response.Status.OK,
                        SupabaseSyncService.register(body.optString("username"), body.optString("email"), body.optString("password"))
                    )
                }

                uri == "/api/auth/session" -> {
                    val body = readJsonBody(session)
                    if (bearer.isEmpty()) return errorResponse(Response.Status.UNAUTHORIZED, "Oturum anahtarı gerekli.")
                    jsonResponse(Response.Status.OK, SupabaseSyncService.validateSession(bearer, body.optString("refresh_token")))
                }

                uri == "/api/auth/logout" -> jsonResponse(Response.Status.OK, JSONObject().put("success", true))

                uri == "/api/sync/pull" -> {
                    if (bearer.isEmpty()) return errorResponse(Response.Status.UNAUTHORIZED, "Yetkilendirme tokenı eksik.")
                    jsonResponse(Response.Status.OK, SupabaseSyncService.pullAccountData(bearer))
                }

                uri == "/api/sync/push" -> {
                    if (bearer.isEmpty()) return errorResponse(Response.Status.UNAUTHORIZED, "Yetkilendirme tokenı eksik.")
                    val body = readJsonBody(session)
                    val result = SupabaseSyncService.pushAccountData(
                        bearer,
                        body.optJSONArray("playlists") ?: JSONArray(),
                        body.optJSONArray("likedTracks") ?: JSONArray(),
                        body.optJSONObject("listeningStats") ?: JSONObject()
                    )
                    jsonResponse(Response.Status.OK, result)
                }

                uri == "/api/sync/recovered-stats" -> jsonResponse(
                    Response.Status.OK,
                    JSONObject().put("listeningStats", JSONObject.NULL)
                )

                uri == "/api/discover/play" -> {
                    val body = readJsonBody(session)
                    val t = body.optJSONObject("track") ?: JSONObject()
                    if (t.optString("title").isNotBlank()) {
                        Thread {
                            SupabaseSyncService.recordPlay(
                                t.optString("id"),
                                t.optString("title"),
                                t.optString("artist"),
                                t.optString("thumbnail")
                            )
                        }.start()
                    }
                    jsonResponse(Response.Status.OK, JSONObject().put("success", true))
                }

                uri == "/api/discover/top" -> {
                    val limit = params["limit"]?.toIntOrNull() ?: 10
                    jsonResponse(Response.Status.OK, JSONObject().put("tracks", SupabaseSyncService.fetchChart("get_sunify_global_top", limit)))
                }

                uri == "/api/discover/daily-top" -> {
                    val limit = params["limit"]?.toIntOrNull() ?: 25
                    jsonResponse(Response.Status.OK, JSONObject().put("tracks", SupabaseSyncService.fetchChart("get_sunify_daily_top", limit)))
                }

                uri == "/api/updates/latest" -> jsonResponse(
                    Response.Status.OK,
                    JSONObject().put("updateAvailable", false).put("currentVersion", "1.2.1")
                )

                else -> jsonResponse(Response.Status.OK, JSONObject().put("ok", true))
            }
        } catch (e: Exception) {
            errorResponse(Response.Status.BAD_GATEWAY, e.message ?: "İşlem başarısız.")
        }
    }

    private fun handleAudioStream(session: IHTTPSession, params: Map<String, String>): Response {
        val id = params["id"].orEmpty()
        val q = params["q"].orEmpty()
        val title = params["title"].orEmpty()
        val artist = params["artist"].orEmpty()
        val stream = audioService.resolveAudioStream(id.ifEmpty { q }, title, artist)

        val rangeHeader = session.headers["range"]
        val reqBuilder = Request.Builder()
            .url(stream.url)
            .header("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36")
        if (!rangeHeader.isNullOrBlank()) reqBuilder.header("Range", rangeHeader)

        val upstream = OkHttpDownloader.sharedClient.newCall(reqBuilder.build()).execute()
        if (!upstream.isSuccessful && upstream.code != 206) {
            upstream.close()
            return errorResponse(Response.Status.BAD_GATEWAY, "Ses akışı başlatılamadı (${upstream.code}).")
        }

        val status = if (upstream.code == 206) Response.Status.PARTIAL_CONTENT else Response.Status.OK
        val contentType = upstream.header("Content-Type") ?: stream.mimeType
        val contentLength = upstream.header("Content-Length")?.toLongOrNull() ?: -1L
        val bodyStream = upstream.body?.byteStream() ?: return errorResponse(Response.Status.BAD_GATEWAY, "Boş ses akışı.")

        val resp = if (contentLength >= 0) {
            newFixedLengthResponse(status, contentType, bodyStream, contentLength)
        } else {
            newChunkedResponse(status, contentType, bodyStream)
        }
        resp.addHeader("Accept-Ranges", "bytes")
        resp.addHeader("Access-Control-Allow-Origin", "*")
        upstream.header("Content-Range")?.let { resp.addHeader("Content-Range", it) }
        return resp
    }

    private fun serveFileWithRange(session: IHTTPSession, file: File, mime: String): Response {
        val len = file.length()
        val range = session.headers["range"]
        if (range != null && range.startsWith("bytes=")) {
            val parts = range.removePrefix("bytes=").split("-")
            val start = parts.getOrNull(0)?.toLongOrNull() ?: 0L
            val end = parts.getOrNull(1)?.toLongOrNull() ?: (len - 1)
            val chunkLen = (end - start + 1).coerceAtLeast(1L)
            val fis = file.inputStream()
            fis.skip(start)
            return newFixedLengthResponse(Response.Status.PARTIAL_CONTENT, mime, fis, chunkLen).apply {
                addHeader("Content-Range", "bytes $start-$end/$len")
                addHeader("Accept-Ranges", "bytes")
                addHeader("Access-Control-Allow-Origin", "*")
            }
        }
        return newFixedLengthResponse(Response.Status.OK, mime, file.inputStream(), len).apply {
            addHeader("Accept-Ranges", "bytes")
            addHeader("Access-Control-Allow-Origin", "*")
        }
    }
}
