package com.sunify.mobile

import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap

object LyricsService {
    private val cache = ConcurrentHashMap<String, JSONObject>()

    private fun enc(value: String): String = URLEncoder.encode(value, "UTF-8")

    fun fetchLyrics(title: String, artist: String, duration: Double, source: String = "auto"): JSONObject {
        val cleanTitle = title.replace(Regex("\\([^)]*\\)|\\[[^\\]]*\\]"), "").trim().ifEmpty { title.trim() }
        val cleanArtist = artist.split(Regex("[,&/]|feat\\.?|ft\\.?", RegexOption.IGNORE_CASE)).firstOrNull()?.trim().orEmpty()
        val cacheKey = "${cleanArtist.lowercase()}|${cleanTitle.lowercase()}|${source.lowercase()}"
        cache[cacheKey]?.let { return it }

        val result = when (source.lowercase()) {
            "lrclib" -> tryLrcLib(cleanTitle, cleanArtist, duration)
            "genius" -> tryGenius(cleanTitle, cleanArtist)
            "lyricsovh" -> tryLyricsOvh(cleanTitle, cleanArtist)
            else -> tryLrcLib(cleanTitle, cleanArtist, duration)
                ?: tryGenius(cleanTitle, cleanArtist)
                ?: tryLyricsOvh(cleanTitle, cleanArtist)
        } ?: JSONObject().apply {
            put("lyrics", "")
            put("synced", false)
            put("source", "Bulunamadı")
            put("lyricsType", "none")
            put("wordSynced", false)
            put("fallbackSources", JSONArray())
        }

        if (result.optString("lyrics").isNotBlank()) {
            if (cache.size > 100) cache.clear()
            cache[cacheKey] = result
        }
        return result
    }

    private fun httpGet(url: String): String? {
        val req = Request.Builder()
            .url(url)
            .header("User-Agent", "SunifyMobile/1.2.1")
            .build()
        return runCatching {
            OkHttpDownloader.sharedClient.newCall(req).execute().use { res ->
                if (!res.isSuccessful) null else res.body?.string()
            }
        }.getOrNull()
    }

    private fun tryLrcLib(title: String, artist: String, duration: Double): JSONObject? {
        val q = enc("$artist $title".trim())
        val raw = httpGet("https://lrclib.net/api/search?q=$q") ?: return null
        val arr = runCatching { JSONArray(raw) }.getOrNull() ?: return null
        if (arr.length() == 0) return null

        var best: JSONObject? = null
        var bestScore = -1.0
        for (i in 0 until minOf(8, arr.length())) {
            val item = arr.optJSONObject(i) ?: continue
            val synced = item.optString("syncedLyrics").trim()
            val plain = item.optString("plainLyrics").trim()
            if (synced.isEmpty() && plain.isEmpty()) continue
            var score = if (synced.isNotEmpty()) 2.0 else 1.0
            val itemArtist = item.optString("artistName").lowercase()
            if (artist.isNotEmpty() && (itemArtist.contains(artist.lowercase()) || artist.lowercase().contains(itemArtist))) {
                score += 2.0
            }
            val dur = item.optDouble("duration", 0.0)
            if (duration > 0 && dur > 0 && kotlin.math.abs(dur - duration) <= 15.0) {
                score += 1.0
            }
            if (score > bestScore) {
                bestScore = score
                best = item
            }
        }
        val chosen = best ?: return null
        val synced = chosen.optString("syncedLyrics").trim()
        val plain = chosen.optString("plainLyrics").trim()
        return JSONObject().apply {
            put("lyrics", synced.ifEmpty { plain })
            put("synced", synced.isNotEmpty())
            put("source", if (synced.isNotEmpty()) "LRCLIB · Senkron" else "LRCLIB")
            put("lyricsType", if (synced.isNotEmpty()) "synced" else "plain")
            put("wordSynced", false)
            put("fallbackSources", JSONArray(listOf("lrclib", "genius", "lyricsovh")))
        }
    }

    private fun tryGenius(title: String, artist: String): JSONObject? {
        val searchRaw = httpGet("https://genius.com/api/search/multi?q=${enc("$artist $title".trim())}") ?: return null
        val json = runCatching { JSONObject(searchRaw) }.getOrNull() ?: return null
        val sections = json.optJSONObject("response")?.optJSONArray("sections") ?: return null
        var songUrl = ""
        for (i in 0 until sections.length()) {
            val hits = sections.optJSONObject(i)?.optJSONArray("hits") ?: continue
            for (j in 0 until hits.length()) {
                val res = hits.optJSONObject(j)?.optJSONObject("result") ?: continue
                val url = res.optString("url")
                if (url.startsWith("https://genius.com/") && url.endsWith("-lyrics")) {
                    songUrl = url
                    break
                }
            }
            if (songUrl.isNotEmpty()) break
        }
        if (songUrl.isEmpty()) return null
        val html = httpGet(songUrl) ?: return null
        val containerRegex = Regex("<div[^>]*data-lyrics-container=\"true\"[^>]*>(.*?)</div>\\s*(?:<div[^>]*class=\"LyricsFooter|<div[^>]*data-lyrics-container)", RegexOption.DOT_MATCHES_ALL)
        val matches = containerRegex.findAll(html).toList()
        val rawBody = if (matches.isNotEmpty()) {
            matches.joinToString("\n") { it.groupValues[1] }
        } else {
            val simple = Regex("<div[^>]*data-lyrics-container=\"true\"[^>]*>(.*?)</div>", RegexOption.DOT_MATCHES_ALL)
                .findAll(html).joinToString("\n") { it.groupValues[1] }
            simple
        }
        val clean = rawBody
            .replace(Regex("<br\\s*/?>", RegexOption.IGNORE_CASE), "\n")
            .replace(Regex("<[^>]+>"), "")
            .replace("&amp;", "&")
            .replace("&#x27;", "'")
            .replace("&quot;", "\"")
            .replace(Regex("\\n{3,}"), "\n\n")
            .trim()
        if (clean.length < 20) return null
        return JSONObject().apply {
            put("lyrics", clean)
            put("synced", false)
            put("source", "Genius")
            put("lyricsType", "plain")
            put("wordSynced", false)
            put("fallbackSources", JSONArray(listOf("lrclib", "genius", "lyricsovh")))
        }
    }

    private fun tryLyricsOvh(title: String, artist: String): JSONObject? {
        if (artist.isEmpty() || title.isEmpty()) return null
        val raw = httpGet("https://api.lyrics.ovh/v1/${enc(artist)}/${enc(title)}") ?: return null
        val lyrics = runCatching { JSONObject(raw).optString("lyrics").trim() }.getOrNull().orEmpty()
        if (lyrics.isEmpty()) return null
        return JSONObject().apply {
            put("lyrics", lyrics)
            put("synced", false)
            put("source", "LyricsOVH")
            put("lyricsType", "plain")
            put("wordSynced", false)
            put("fallbackSources", JSONArray(listOf("lrclib", "genius", "lyricsovh")))
        }
    }
}
