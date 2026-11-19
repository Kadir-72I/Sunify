package com.sunify.mobile

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

object SupabaseSyncService {
    private const val SUPABASE_URL = "https://wkphoyochjczmqdmuazo.supabase.co"
    private const val ANON_KEY = "sb_publishable_mEBku9YdyAUCUXGy96Y7UQ_erV1j-9L"
    private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

    data class HttpResult(val code: Int, val body: String)

    private fun call(method: String, path: String, body: String? = null, bearer: String? = null): HttpResult {
        val reqBuilder = Request.Builder()
            .url("$SUPABASE_URL$path")
            .header("apikey", ANON_KEY)
            .header("Authorization", "Bearer ${bearer ?: ANON_KEY}")
            .header("Content-Type", "application/json")

        val reqBody = body?.toRequestBody(JSON_MEDIA)
        when (method.uppercase()) {
            "GET" -> reqBuilder.get()
            "POST" -> reqBuilder.post(reqBody ?: "{}".toRequestBody(JSON_MEDIA))
            "DELETE" -> reqBuilder.delete(reqBody)
        }
        OkHttpDownloader.sharedClient.newCall(reqBuilder.build()).execute().use { res ->
            return HttpResult(res.code, res.body?.string().orEmpty())
        }
    }

    fun login(email: String, password: String): JSONObject {
        val payload = JSONObject().apply {
            put("email", email.trim().lowercase())
            put("password", password)
        }.toString()
        val res = call("POST", "/auth/v1/token?grant_type=password", payload)
        val json = runCatching { JSONObject(res.body) }.getOrDefault(JSONObject())
        if (res.code !in 200..299 || !json.has("access_token")) {
            val msg = json.optString("error_description")
                .ifEmpty { json.optString("msg") }
                .ifEmpty { "E-posta veya şifre hatalı." }
            throw IllegalStateException(msg)
        }
        return JSONObject().apply {
            put("success", true)
            put("mode", "cloud")
            put("user", json.optJSONObject("user") ?: JSONObject())
            put("session", json)
        }
    }

    fun register(username: String, email: String, password: String): JSONObject {
        val payload = JSONObject().apply {
            put("email", email.trim().lowercase())
            put("password", password)
            put("data", JSONObject().put("username", username.trim()))
        }.toString()
        val res = call("POST", "/auth/v1/signup", payload)
        val json = runCatching { JSONObject(res.body) }.getOrDefault(JSONObject())
        if (res.code !in 200..299) {
            val msg = json.optString("msg").ifEmpty { json.optString("error_description") }.ifEmpty { "Kayıt tamamlanamadı." }
            throw IllegalStateException(msg)
        }
        val session = if (json.has("access_token")) json else JSONObject.NULL
        val user = json.optJSONObject("user") ?: json
        return JSONObject().apply {
            put("success", true)
            put("mode", "cloud")
            put("user", user)
            put("session", session)
            put("needsEmailVerification", session === JSONObject.NULL)
        }
    }

    fun validateSession(accessToken: String, refreshToken: String): JSONObject {
        val userRes = call("GET", "/auth/v1/user", bearer = accessToken)
        if (userRes.code in 200..299) {
            return JSONObject().apply {
                put("success", true)
                put("valid", true)
                put("mode", "cloud")
            }
        }
        if (refreshToken.isNotBlank()) {
            val refPayload = JSONObject().put("refresh_token", refreshToken).toString()
            val refRes = call("POST", "/auth/v1/token?grant_type=refresh_token", refPayload)
            val refJson = runCatching { JSONObject(refRes.body) }.getOrDefault(JSONObject())
            if (refRes.code in 200..299 && refJson.has("access_token")) {
                return JSONObject().apply {
                    put("success", true)
                    put("valid", true)
                    put("mode", "cloud")
                    put("refreshed", true)
                    put("user", refJson.optJSONObject("user") ?: JSONObject())
                    put("session", refJson)
                }
            }
        }
        throw IllegalStateException("Oturumun süresi dolmuş. Lütfen yeniden giriş yap.")
    }

    fun pullAccountData(accessToken: String): JSONObject {
        val plRes = call(
            "GET",
            "/rest/v1/user_playlists?select=id,client_id,name,cover_url,tracks,created_at&order=created_at.desc",
            bearer = accessToken
        )
        if (plRes.code !in 200..299) throw IllegalStateException("Bulut çalma listeleri alınamadı.")
        val rawPls = runCatching { JSONArray(plRes.body) }.getOrDefault(JSONArray())
        val playlists = JSONArray()
        for (i in 0 until rawPls.length()) {
            val row = rawPls.optJSONObject(i) ?: continue
            playlists.put(JSONObject().apply {
                put("id", row.optString("client_id").ifEmpty { row.optString("id") })
                put("name", row.optString("name"))
                put("cover", row.optString("cover_url"))
                put("tracks", row.optJSONArray("tracks") ?: JSONArray())
                put("created_at", row.optString("created_at"))
            })
        }

        val anRes = call(
            "GET",
            "/rest/v1/user_analytics?select=liked_tracks,listening_stats&limit=1",
            bearer = accessToken
        )
        val anArr = runCatching { JSONArray(anRes.body) }.getOrDefault(JSONArray())
        val anObj = anArr.optJSONObject(0) ?: JSONObject()

        return JSONObject().apply {
            put("playlists", playlists)
            put("analytics", JSONObject().apply {
                put("liked_tracks", anObj.optJSONArray("liked_tracks") ?: JSONArray())
                put("listening_stats", anObj.optJSONObject("listening_stats") ?: JSONObject())
            })
        }
    }

    fun pushAccountData(accessToken: String, playlists: JSONArray, likedTracks: JSONArray, listeningStats: JSONObject): JSONObject {
        val payload = JSONObject().apply {
            put("p_playlists", playlists)
            put("p_liked_tracks", likedTracks)
            put("p_listening_stats", listeningStats)
        }.toString()
        val res = call("POST", "/rest/v1/rpc/sync_sunify_account_data", payload, bearer = accessToken)
        if (res.code !in 200..299) {
            throw IllegalStateException("Bulut eşitlemesi kaydedilemedi (${res.code}).")
        }
        return JSONObject().put("success", true)
    }

    fun recordPlay(trackId: String, title: String, artist: String, thumbnail: String) {
        val payload = JSONObject().apply {
            put("track_id", trackId.take(200))
            put("track_title", title.take(300))
            put("track_artist", artist.take(300))
            put("track_thumbnail", thumbnail.take(1000))
        }.toString()
        runCatching { call("POST", "/rest/v1/rpc/record_sunify_play", payload) }
    }

    fun fetchChart(rpcName: String, limit: Int): JSONArray {
        val payload = JSONObject().put("result_limit", limit.coerceIn(1, 25)).toString()
        val res = call("POST", "/rest/v1/rpc/$rpcName", payload)
        if (res.code !in 200..299) return JSONArray()
        val raw = runCatching { JSONArray(res.body) }.getOrDefault(JSONArray())
        val out = JSONArray()
        for (i in 0 until raw.length()) {
            val row = raw.optJSONObject(i) ?: continue
            val t = row.optString("title")
            val a = row.optString("artist")
            out.put(JSONObject().apply {
                put("id", row.optString("track_id"))
                put("title", t)
                put("artist", a)
                put("thumbnail", row.optString("thumbnail"))
                put("playCount", row.optLong("play_count", 0))
                put("query", "$a $t".trim())
            })
        }
        return out
    }
}
