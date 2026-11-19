package com.sunify.mobile

import android.content.Context
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import org.schabi.newpipe.extractor.InfoItem
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.playlist.PlaylistInfo
import org.schabi.newpipe.extractor.playlist.PlaylistInfoItem
import org.schabi.newpipe.extractor.search.SearchInfo
import org.schabi.newpipe.extractor.stream.AudioStream
import org.schabi.newpipe.extractor.stream.StreamInfo
import org.schabi.newpipe.extractor.stream.StreamInfoItem
import java.io.File
import java.security.MessageDigest
import java.text.Normalizer
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

class YouTubeAudioService(private val context: Context) {

    data class TrackItem(
        val id: String,
        val title: String,
        val artist: String,
        val thumbnail: String,
        val duration: Long,
        val query: String,
        val reason: String = ""
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("id", id)
            put("title", title)
            put("artist", artist)
            put("thumbnail", thumbnail)
            put("duration", duration)
            put("query", query)
            if (reason.isNotEmpty()) put("reason", reason)
        }
    }

    data class CachedStream(
        val url: String,
        val mimeType: String,
        val expiresAt: Long
    )

    private val searchCache = ConcurrentHashMap<String, Pair<Long, List<TrackItem>>>()
    private val streamCache = ConcurrentHashMap<String, CachedStream>()
    private val queryToVideoId = ConcurrentHashMap<String, String>()

    val cacheDir: File by lazy {
        File(context.cacheDir, "SunifyAudioCache").apply { mkdirs() }
    }
    val downloadsDir: File by lazy {
        File(context.filesDir, "downloads").apply { mkdirs() }
    }

    @Volatile
    var cacheLimitBytes: Long = 512L * 1024L * 1024L

    @Volatile
    var downloadLimitBytes: Long = 5L * 1024L * 1024L * 1024L

    private val junkRegex = Regex(
        "\\b(full album|full ep|1 hour|2 hours|3 hours|10 hours|1 saat|2 saat|playlist|mixtape|compilation|derleme|reaction|inceleme|teaser|trailer|fragman|karaoke|instrumental|altyap[ıi]|type beat|free beat|ringtone|zil sesi|shorts|tiktok|live stream|canl[ıi] yay[ıi]n|podcast|interview|röportaj)\\b",
        RegexOption.IGNORE_CASE
    )
    private val chillOnlyRegex = Regex(
        "\\b(slowed|reverb|8d audio|nightcore|sped up)\\b",
        RegexOption.IGNORE_CASE
    )

    fun extractVideoId(urlOrId: String): String {
        val raw = urlOrId.trim()
        if (Regex("^[a-zA-Z0-9_-]{11}$").matches(raw)) return raw
        val match = Regex("(?:v=|youtu\\.be/|shorts/|embed/)([a-zA-Z0-9_-]{11})").find(raw)
        return match?.groupValues?.getOrNull(1).orEmpty()
    }

    fun cleanMetadata(rawTitle: String, rawAuthor: String): Pair<String, String> {
        var title = rawTitle.trim()
        var artist = rawAuthor.replace(Regex("\\s*-\\s*Topic$", RegexOption.IGNORE_CASE), "").trim()
        title = title.replace(
            Regex("\\s*[\\[(](?:official\\s*(?:music\\s*)?(?:video|audio|lyric\\s*video|visualizer)|lyrics?|hd|4k|audio|video|offiziell[^)\\]]*)[\\])]", RegexOption.IGNORE_CASE),
            ""
        ).trim()

        val splitMatch = Regex("^(.{2,45}?)\\s+[-–—]\\s+(.+)$").find(title)
        if (splitMatch != null) {
            val left = splitMatch.groupValues[1].trim()
            val right = splitMatch.groupValues[2].trim()
            if (artist.isEmpty() || artist.equals(left, ignoreCase = true) || artist.contains(left, ignoreCase = true)) {
                artist = left
                title = right
            } else if (title.contains(" - ")) {
                artist = left
                title = right
            }
        }
        return (title.ifEmpty { rawTitle }) to (artist.ifEmpty { rawAuthor.ifEmpty { "Bilinmeyen Sanatçı" } })
    }

    private fun bestThumb(item: InfoItem, videoId: String): String {
        val thumbs = item.thumbnails
        val best = thumbs.lastOrNull()?.url ?: thumbs.firstOrNull()?.url
        if (!best.isNullOrBlank()) return best
        return if (videoId.isNotEmpty()) "https://i.ytimg.com/vi/$videoId/hqdefault.jpg" else ""
    }

    fun searchTracks(query: String, forceRefresh: Boolean = false): List<TrackItem> {
        val key = query.trim().lowercase(Locale("tr", "TR"))
        if (!forceRefresh) {
            searchCache[key]?.let { (ts, items) ->
                if (System.currentTimeMillis() - ts < 10 * 60 * 1000L) return items
            }
        }
        val yt = ServiceList.YouTube
        val qh = yt.searchQHFactory.fromQuery(query)
        val info = SearchInfo.getInfo(yt, qh)
        val items = info.relatedItems
            .filterIsInstance<StreamInfoItem>()
            .filter { !it.isShortFormContent && it.duration > 0 }
            .take(20)
            .mapNotNull { item ->
                val vid = extractVideoId(item.url)
                if (vid.isEmpty()) return@mapNotNull null
                val (cleanTitle, cleanArtist) = cleanMetadata(item.name.orEmpty(), item.uploaderName.orEmpty())
                TrackItem(
                    id = vid,
                    title = cleanTitle,
                    artist = cleanArtist,
                    thumbnail = bestThumb(item, vid),
                    duration = max(0L, item.duration),
                    query = "$cleanArtist $cleanTitle".trim()
                )
            }
        if (searchCache.size > 60) searchCache.clear()
        searchCache[key] = System.currentTimeMillis() to items
        return items
    }

    fun searchPlaylists(query: String): JSONArray {
        val yt = ServiceList.YouTube
        val qh = yt.searchQHFactory.fromQuery(query, listOf("playlists"), "")
        val info = SearchInfo.getInfo(yt, qh)
        val arr = JSONArray()
        info.relatedItems.filterIsInstance<PlaylistInfoItem>().take(12).forEach { pl ->
            val url = pl.url.orEmpty()
            val listId = Regex("[?&]list=([^&]+)").find(url)?.groupValues?.getOrNull(1) ?: url
            arr.put(JSONObject().apply {
                put("id", listId)
                put("title", pl.name ?: "Çalma listesi")
                put("author", pl.uploaderName ?: "YouTube")
                put("thumbnail", pl.thumbnails.lastOrNull()?.url ?: pl.thumbnails.firstOrNull()?.url ?: "")
                put("size", if (pl.streamCount > 0) "${pl.streamCount} şarkı" else "Çalma listesi")
                put("url", url)
            })
        }
        return arr
    }

    fun importPlaylist(url: String): JSONObject {
        val info = PlaylistInfo.getInfo(ServiceList.YouTube, url)
        val tracks = JSONArray()
        info.relatedItems.take(100).forEach { item ->
            val vid = extractVideoId(item.url)
            if (vid.isNotEmpty()) {
                val (cleanTitle, cleanArtist) = cleanMetadata(item.name.orEmpty(), item.uploaderName.orEmpty())
                tracks.put(
                    TrackItem(
                        id = vid,
                        title = cleanTitle,
                        artist = cleanArtist,
                        thumbnail = bestThumb(item, vid),
                        duration = max(0L, item.duration),
                        query = "$cleanArtist $cleanTitle".trim()
                    ).toJson()
                )
            }
        }
        return JSONObject().apply {
            put("name", info.name ?: "İçe Aktarılan Liste")
            put("author", info.uploaderName ?: "YouTube")
            put("thumbnail", info.thumbnails.lastOrNull()?.url ?: "")
            put("tracks", tracks)
        }
    }

    fun normalizeRecText(value: String): String {
        val decomposed = Normalizer.normalize(value, Normalizer.Form.NFD)
            .replace(Regex("[\\u0300-\\u036f]"), "")
            .lowercase(Locale("tr", "TR"))
        return decomposed
            .replace(Regex("\\([^)]*\\)|\\[[^\\]]*\\]"), " ")
            .replace(Regex("\\b(official|music video|video|audio|lyrics?|visuali[sz]er|topic|remaster(?:ed)?|hd|4k|slowed|sped up|nightcore|karaoke|cover)\\b"), " ")
            .replace(Regex("[^a-z0-9]+"), " ")
            .trim()
            .replace(Regex("\\s+"), " ")
    }

    private fun textSimilarity(left: String, right: String): Double {
        val a = normalizeRecText(left).split(" ").filter { it.length > 1 }.toSet()
        val b = normalizeRecText(right).split(" ").filter { it.length > 1 }.toSet()
        if (a.isEmpty() || b.isEmpty()) return 0.0
        val inter = a.intersect(b).size
        return inter.toDouble() / (a.size + b.size - inter).toDouble()
    }

    private fun isJunkVideo(title: String, duration: Long, mode: String): Boolean {
        if (junkRegex.containsMatchIn(title)) return true
        if (mode != "chill" && chillOnlyRegex.containsMatchIn(title)) return true
        if (duration > 0 && (duration < 60 || duration > 510)) return true
        return false
    }

    private data class Seed(val title: String, val artist: String, val duration: Long, val weight: Int)

    private data class Candidate(
        val track: TrackItem,
        var score: Double,
        val artistKey: String,
        var reason: String,
        val matchedSeeds: MutableSet<Int>
    )

    fun getRecommendations(
        seedsJson: String?,
        query: String?,
        modeParam: String?,
        excludeArtistsJson: String?,
        forceRefresh: Boolean
    ): List<TrackItem> {
        val mode = if (modeParam in setOf("all", "similar", "discovery", "energetic", "chill")) modeParam!! else "all"
        val seeds = mutableListOf<Seed>()
        if (!seedsJson.isNullOrBlank()) {
            val arr = JSONArray(seedsJson)
            for (i in 0 until min(6, arr.length())) {
                val obj = arr.optJSONObject(i) ?: continue
                val t = obj.optString("title").trim()
                if (t.isNotEmpty()) {
                    seeds.add(
                        Seed(
                            title = t.take(160),
                            artist = obj.optString("artist").trim().take(120),
                            duration = max(0L, obj.optLong("duration", 0L)),
                            weight = obj.optInt("weight", 1).coerceIn(1, 8)
                        )
                    )
                }
            }
        }
        if (seeds.isEmpty() && !query.isNullOrBlank()) {
            seeds.add(Seed(query.trim().take(160), "", 0L, 1))
        }
        if (seeds.isEmpty()) return emptyList()

        val excludedArtists = mutableSetOf<String>()
        if (!excludeArtistsJson.isNullOrBlank()) {
            runCatching {
                val arr = JSONArray(excludeArtistsJson)
                for (i in 0 until arr.length()) {
                    val k = normalizeRecText(arr.optString(i))
                    if (k.isNotEmpty()) excludedArtists.add(k)
                }
            }
        }
        val seedArtists = seeds.map { normalizeRecText(it.artist) }.filter { it.isNotEmpty() }.toSet()

        val candidates = linkedMapOf<String, Candidate>()
        seeds.forEachIndexed { seedIdx, seed ->
            val queries = when {
                seed.artist.isEmpty() -> listOf(seed.title)
                mode == "discovery" -> if (seedIdx % 2 == 0) listOf("${seed.artist} feat", "${seed.artist} ${seed.title} mix") else listOf("${seed.artist} düet", "songs like ${seed.artist} ${seed.title}")
                mode == "energetic" -> listOf("${seed.artist} ${seed.title} remix", "${seed.artist} hareketli popüler şarkılar")
                mode == "chill" -> listOf("${seed.artist} akustik slow", "${seed.artist} ${seed.title} chill")
                mode == "similar" -> if (seedIdx == 0) listOf("${seed.artist} ${seed.title} mix", "${seed.artist} feat") else listOf("${seed.artist} ${seed.title} radio")
                else -> if (seedIdx < 2) listOf("${seed.artist} ${seed.title} mix", "${seed.artist} feat") else listOf("${seed.artist} ${seed.title} radio")
            }

            queries.forEachIndexed { qIdx, sq ->
                val results = runCatching { searchTracks(sq, forceRefresh && qIdx == 0) }.getOrDefault(emptyList())
                results.take(14).forEach { track ->
                    if (isJunkVideo(track.title, track.duration, mode)) return@forEach
                    val artistKey = normalizeRecText(track.artist)
                    if (artistKey.isEmpty() || artistKey == "bilinmeyen sanatci") return@forEach
                    val sameArtist = seedArtists.contains(artistKey)
                    val titleMatch = seeds.maxOf { textSimilarity(track.title, it.title) }
                    if (titleMatch >= if (sameArtist) 0.62 else 0.85) return@forEach

                    val isCollab = Regex("\\b(feat\\.?|ft\\.?|x|&|,)\\b", RegexOption.IGNORE_CASE)
                        .containsMatchIn("${track.artist} ${track.title}")
                    if (mode == "discovery" && (sameArtist || excludedArtists.contains(artistKey)) && !isCollab) {
                        return@forEach
                    }

                    var score = seed.weight * 0.35 + (if (isCollab) 0.55 else 0.0)
                    score += if (mode == "discovery" && !sameArtist && !excludedArtists.contains(artistKey)) 2.1 else 0.9

                    val cKey = "$artistKey|${normalizeRecText(track.title)}"
                    val existing = candidates[cKey]
                    if (existing != null) {
                        existing.matchedSeeds.add(seedIdx)
                        existing.score = max(existing.score, score) + (existing.matchedSeeds.size - 1) * 1.65
                        if (existing.matchedSeeds.size >= 2) {
                            existing.reason = "🔥 ${existing.matchedSeeds.size} favori şarkınla ortak eşleşme"
                        }
                    } else {
                        val label = seed.artist.ifEmpty { seed.title }
                        val reason = when {
                            mode == "discovery" && !sameArtist -> "🧭 $label sevenlere yeni keşif"
                            mode == "energetic" -> "⚡ Enerjik mod · $label"
                            mode == "chill" -> "🌙 Gece & Chill · $label"
                            isCollab && sameArtist -> "🤝 $label ortak çalışması"
                            else -> "🎯 $label tarzına göre"
                        }
                        candidates[cKey] = Candidate(track, score, artistKey, reason, mutableSetOf(seedIdx))
                    }
                }
            }
        }

        val ranked = candidates.values.sortedByDescending { it.score }
        val output = mutableListOf<TrackItem>()
        val artistCounts = mutableMapOf<String, Int>()
        val maxPerArtist = if (mode == "discovery") 1 else 2
        var lastArtist = ""
        for (c in ranked) {
            if (output.any { textSimilarity(it.title, c.track.title) >= 0.8 }) continue
            val count = artistCounts[c.artistKey] ?: 0
            if (count >= maxPerArtist || c.artistKey == lastArtist) continue
            output.add(c.track.copy(reason = c.reason))
            artistCounts[c.artistKey] = count + 1
            lastArtist = c.artistKey
            if (output.size >= 25) break
        }
        return output
    }

    fun getArtistMixTracks(artistsJson: String): List<TrackItem> {
        val arr = runCatching { JSONArray(artistsJson) }.getOrNull() ?: return emptyList()
        val artists = (0 until min(6, arr.length())).mapNotNull { arr.optString(it).trim().takeIf { s -> s.isNotEmpty() } }
        if (artists.isEmpty()) return emptyList()
        val seen = HashSet<String>()
        val out = mutableListOf<TrackItem>()
        artists.forEach { artist ->
            val items = runCatching { searchTracks("$artist songs") }.getOrDefault(emptyList())
            items.filter { !isJunkVideo(it.title, it.duration, "all") }.forEach { track ->
                val k = normalizeRecText("${track.artist} ${track.title}")
                if (seen.add(k) && out.size < 25) out.add(track)
            }
        }
        return out
    }

    fun resolveVideoIdForQuery(query: String, excludeVideoIds: Set<String> = emptySet()): String {
        val norm = query.trim().lowercase(Locale("tr", "TR"))
        if (excludeVideoIds.isEmpty()) {
            queryToVideoId[norm]?.let { return it }
        }
        val tracks = searchTracks(query, forceRefresh = excludeVideoIds.isNotEmpty())
        val found = tracks.firstOrNull { it.id !in excludeVideoIds }?.id.orEmpty()
        if (found.isNotEmpty() && excludeVideoIds.isEmpty()) {
            queryToVideoId[norm] = found
        }
        return found
    }

    fun resolveAudioStream(videoIdOrQuery: String, title: String = "", artist: String = ""): CachedStream {
        val vid = extractVideoId(videoIdOrQuery).ifEmpty {
            val q = "$artist $title".trim().ifEmpty { videoIdOrQuery }
            resolveVideoIdForQuery(q)
        }
        if (vid.isEmpty()) throw IllegalStateException("Şarkı YouTube üzerinde bulunamadı.")

        streamCache[vid]?.let { cached ->
            if (System.currentTimeMillis() < cached.expiresAt) return cached
        }

        val info = StreamInfo.getInfo(ServiceList.YouTube, "https://www.youtube.com/watch?v=$vid")
        val bestAudio: AudioStream = info.audioStreams
            .filter { !it.content.isNullOrBlank() }
            .maxByOrNull { it.averageBitrate }
            ?: throw IllegalStateException("Bu parça için ses akışı bulunamadı.")

        val mime = bestAudio.format?.mimeType ?: "audio/mp4"
        val cached = CachedStream(
            url = bestAudio.content,
            mimeType = mime,
            expiresAt = System.currentTimeMillis() + 40 * 60 * 1000L
        )
        streamCache[vid] = cached
        return cached
    }

    fun cacheFileForKey(key: String): File {
        val hash = MessageDigest.getInstance("SHA-256")
            .digest(key.toByteArray())
            .joinToString("") { "%02x".format(it) }
        return File(cacheDir, "$hash.m4a")
    }

    fun saveTrackLocally(id: String, title: String, artist: String, query: String): File {
        val safeName = "${artist}_${title}".replace(Regex("[^a-zA-Z0-9._ -]"), "_").take(80)
        val outFile = File(downloadsDir, "$safeName.m4a")
        if (outFile.exists() && outFile.length() > 16 * 1024) return outFile
        val stream = resolveAudioStream(id.ifEmpty { query }, title, artist)
        val req = Request.Builder().url(stream.url).build()
        OkHttpDownloader.sharedClient.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw IllegalStateException("İndirme başarısız (${res.code})")
            res.body?.byteStream()?.use { input ->
                outFile.outputStream().use { output -> input.copyTo(output) }
            }
        }
        return outFile
    }
}
