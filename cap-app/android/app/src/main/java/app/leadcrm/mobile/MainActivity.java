package app.leadcrm.mobile;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.annotation.NonNull;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.documentfile.provider.DocumentFile;

import com.getcapacitor.BridgeActivity;

import java.io.BufferedOutputStream;
import java.io.BufferedReader;
import java.io.DataOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;

import org.json.JSONArray;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "LeadCRM/Main";
    private static final int REQ_PERMISSIONS = 101;
    private static final int REQ_PICK_FOLDER = 202;
    private static final String PREFS = "leadcrm";
    private static final String KEY_REC_FOLDER = "recording_folder_uri";

    private BroadcastReceiver callReceiver;
    private String pendingPickerCallback = null;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the new CallerId plugin so the JS bridge wires up the
        // CallerId.* API. MUST be before super.onCreate() per Capacitor docs.
        registerPlugin(CallerIdPlugin.class);
        super.onCreate(savedInstanceState);
        requestPermissions();
        registerCallReceiver();
        getBridge().getWebView().addJavascriptInterface(new LeadCRMBridge(), "LeadCRMNative");
        handleSharedIntent(getIntent());
        // Deep-link from the caller-ID notification → navigate the SPA
        handleDeeplink(getIntent());
    }

    private void handleDeeplink(Intent intent) {
        if (intent == null) return;
        String dl = intent.getStringExtra("deeplink");
        if (dl == null || dl.isEmpty()) return;
        // The CRM uses hash-based routing; just set window.location.hash
        getBridge().eval(
            "(function(){try{var h=" + jsString(dl) + ";window.location.hash=h.replace(/^\\/?#/,'');}catch(e){}})();",
            null
        );
    }
    private static String jsString(String s) {
        return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'";
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleSharedIntent(intent);
        handleDeeplink(intent);
    }

    private void handleSharedIntent(Intent intent) {
        if (intent != null && Intent.ACTION_SEND.equals(intent.getAction())
                && "text/plain".equals(intent.getType())) {
            String shared = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (shared != null && !shared.isEmpty()) {
                SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
                prefs.edit().putString("shared_lead_text", shared).apply();
                getBridge().getWebView().postDelayed(() -> {
                    String js = "window.LeadCRMShared = " + jsStr(shared) +
                            "; if (window.onLeadCRMSharedLead) window.onLeadCRMSharedLead(" + jsStr(shared) + ");";
                    getBridge().getWebView().evaluateJavascript(js, null);
                }, 2500);
            }
        }
    }

    private void requestPermissions() {
        String[] perms = {
                Manifest.permission.READ_PHONE_STATE,
                Manifest.permission.CALL_PHONE,
                Manifest.permission.READ_CONTACTS,
                Manifest.permission.POST_NOTIFICATIONS
        };
        boolean need = false;
        for (String p : perms) {
            if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) {
                need = true;
                break;
            }
        }
        if (need) {
            ActivityCompat.requestPermissions(this, perms, REQ_PERMISSIONS);
        }
    }

    private void registerCallReceiver() {
        callReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String event = intent.getStringExtra("event");
                String number = intent.getStringExtra("number");
                if (event == null) return;
                Log.d(TAG, "call event: " + event + " " + number);
                forwardToWebview(event, number);
            }
        };
        IntentFilter f = new IntentFilter("app.leadcrm.mobile.CALL_EVENT");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(callReceiver, f, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(callReceiver, f);
        }
    }

    private void forwardToWebview(String event, String number) {
        WebView wv = getBridge().getWebView();
        if (wv == null) return;
        String js = "window.onLeadCRMCallEvent && window.onLeadCRMCallEvent(" +
                jsStr(event) + "," + jsStr(number) + ");";
        wv.post(() -> wv.evaluateJavascript(js, null));
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_PICK_FOLDER) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                Uri tree = data.getData();
                int flags = Intent.FLAG_GRANT_READ_URI_PERMISSION
                        | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION;
                try {
                    getContentResolver().takePersistableUriPermission(tree, flags);
                } catch (Exception e) {
                    Log.e(TAG, "takePersistableUriPermission: " + e.getMessage());
                }
                SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
                prefs.edit().putString(KEY_REC_FOLDER, tree.toString()).apply();
                String displayName = humanFolderName(tree);
                invokeJsCallback(pendingPickerCallback, true, displayName);
            } else {
                invokeJsCallback(pendingPickerCallback, false, "cancelled");
            }
            pendingPickerCallback = null;
        }
    }

    private static String humanFolderName(Uri tree) {
        String enc = tree.getLastPathSegment();
        if (enc == null) return "Selected folder";
        try { enc = URLDecoder.decode(enc, "UTF-8"); } catch (Exception ignored) {}
        if (enc.startsWith("primary:")) enc = "/" + enc.substring("primary:".length());
        return enc;
    }

    private void invokeJsCallback(String cb, boolean ok, String detail) {
        if (cb == null || cb.isEmpty()) return;
        WebView wv = getBridge().getWebView();
        if (wv == null) return;
        String js = "try{" + cb + "(" + (ok ? "true" : "false") + "," + jsStr(detail) + ");}catch(e){console.error(e);}";
        new Handler(Looper.getMainLooper()).post(() -> wv.evaluateJavascript(js, null));
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (callReceiver != null) {
            try { unregisterReceiver(callReceiver); } catch (Exception ignored) {}
        }
    }

    private static String jsStr(String s) {
        if (s == null) return "null";
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "") + "\"";
    }

    private static boolean isAudioFile(String n) {
        if (n == null) return false;
        String lower = n.toLowerCase();
        return lower.endsWith(".m4a") || lower.endsWith(".mp3") || lower.endsWith(".wav")
                || lower.endsWith(".amr") || lower.endsWith(".aac") || lower.endsWith(".ogg")
                || lower.endsWith(".3gp") || lower.endsWith(".mpeg") || lower.endsWith(".opus");
    }

    private static String guessMime(String n) {
        String lower = n == null ? "" : n.toLowerCase();
        if (lower.endsWith(".m4a")) return "audio/m4a";
        if (lower.endsWith(".mp3")) return "audio/mpeg";
        if (lower.endsWith(".wav")) return "audio/wav";
        if (lower.endsWith(".amr")) return "audio/amr";
        if (lower.endsWith(".aac")) return "audio/aac";
        if (lower.endsWith(".ogg") || lower.endsWith(".opus")) return "audio/ogg";
        if (lower.endsWith(".3gp")) return "audio/3gpp";
        return "audio/mpeg";
    }

    /**
     * One row in a SAF folder listing — populated via a direct
     * ContentResolver query against DocumentsContract instead of going
     * through DocumentFile, which is documented as O(N) per call on some
     * OEMs (Xiaomi MIUI, Realme UI, Vivo Funtouch) and routinely returns
     * null filenames or empty arrays on Android 11+. Direct queries are
     * 100-500× faster and far more reliable.
     */
    private static class SafEntry {
        Uri uri;
        String name;
        String mime;
        long size;
        long modified;
        boolean isDir;
    }

    /**
     * List one folder's children using ContentResolver directly. This is
     * the function the OEM-tolerant scanner is built on — DocumentFile's
     * abstraction layer drops names/timestamps on too many devices.
     */
    private java.util.List<SafEntry> safList(Uri parentDocUri, Uri tree) {
        java.util.List<SafEntry> out = new java.util.ArrayList<>();
        ContentResolver cr = getContentResolver();
        String parentDocId;
        try {
            parentDocId = DocumentsContract.getDocumentId(parentDocUri);
        } catch (Exception e) {
            // Tree URI was passed → derive root document id from it
            try { parentDocId = DocumentsContract.getTreeDocumentId(tree); }
            catch (Exception e2) { return out; }
        }
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentDocId);
        String[] proj = new String[] {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED,
                DocumentsContract.Document.COLUMN_SIZE
        };
        try (Cursor c = cr.query(children, proj, null, null, null)) {
            if (c == null) return out;
            while (c.moveToNext()) {
                SafEntry e = new SafEntry();
                String docId = c.getString(0);
                e.uri = DocumentsContract.buildDocumentUriUsingTree(tree, docId);
                e.name = c.getString(1);
                e.mime = c.getString(2);
                e.modified = c.isNull(3) ? 0L : c.getLong(3);
                e.size = c.isNull(4) ? 0L : c.getLong(4);
                e.isDir = DocumentsContract.Document.MIME_TYPE_DIR.equals(e.mime);
                out.add(e);
            }
        } catch (Exception e) {
            Log.w(TAG, "safList query failed: " + e.getMessage());
        }
        return out;
    }

    /**
     * Walk the folder tree (3 levels deep) looking for an audio file
     * whose filename digits include `tail` (last 7 digits of the dialed
     * phone) and was modified after `sinceMs`. Falls back gracefully
     * when modified timestamps are missing (some MIUI / Realme builds
     * report 0 for SAF document timestamps) — in that case we use file
     * SIZE > 0 + display-name match as the only filter, ranked by
     * lexicographic name (call-recorder filenames are timestamp-sortable
     * on every OEM we've seen).
     */
    private SafEntry findBestSafMatch(Uri tree, String tail, long sinceMs) {
        Uri rootDoc = DocumentsContract.buildDocumentUriUsingTree(
                tree, DocumentsContract.getTreeDocumentId(tree));
        return findBestSafMatchRec(rootDoc, tree, tail, sinceMs, 0, null);
    }

    private SafEntry findBestSafMatchRec(Uri parentDoc, Uri tree, String tail,
                                         long sinceMs, int depth, SafEntry bestSoFar) {
        if (depth > 3) return bestSoFar;
        SafEntry best = bestSoFar;
        long bestKey = best != null ? rankKey(best) : 0;
        for (SafEntry e : safList(parentDoc, tree)) {
            try {
                if (e.isDir) {
                    SafEntry sub = findBestSafMatchRec(e.uri, tree, tail, sinceMs, depth + 1, best);
                    if (sub != null) {
                        long k = rankKey(sub);
                        if (k > bestKey) { best = sub; bestKey = k; }
                    }
                    continue;
                }
                if (e.name == null || e.name.isEmpty()) continue;
                if (!isAudioFile(e.name)) continue;
                if (e.size <= 0) continue;
                if (sinceMs > 0 && e.modified > 0 && e.modified < sinceMs) continue;
                if (tail != null && !tail.isEmpty()) {
                    String fileDigits = e.name.replaceAll("[^0-9]", "");
                    if (!fileDigits.contains(tail)) continue;
                }
                long k = rankKey(e);
                if (k > bestKey) { best = e; bestKey = k; }
            } catch (Exception ignored) {}
        }
        return best;
    }

    /** Ranking key: prefer real timestamps; fall back to lex name. */
    private static long rankKey(SafEntry e) {
        if (e.modified > 0) return e.modified;
        // No modified timestamp → use a name-derived pseudo-time. OEM
        // call recorders embed yyyymmdd-hhmmss in filenames; the longest
        // digit run gives a good ranking proxy.
        String n = e.name == null ? "" : e.name;
        String digits = n.replaceAll("[^0-9]", "");
        if (digits.length() >= 8) {
            try { return Long.parseLong(digits.substring(0, Math.min(14, digits.length()))); }
            catch (Exception ignored) {}
        }
        return 1L; // any positive value beats null bestSoFar
    }

    /* ---------------- JS-facing bridge ---------------- */
    public class LeadCRMBridge {

        @JavascriptInterface
        public void pickRecordingFolder(String callback) {
            pendingPickerCallback = callback;
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            try {
                startActivityForResult(i, REQ_PICK_FOLDER);
            } catch (Exception e) {
                Log.e(TAG, "pickRecordingFolder: " + e.getMessage());
                invokeJsCallback(callback, false, e.getMessage());
                pendingPickerCallback = null;
            }
        }

        @JavascriptInterface
        public String getRecordingFolder() {
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            String s = prefs.getString(KEY_REC_FOLDER, null);
            if (s == null) return "";
            try { return humanFolderName(Uri.parse(s)); } catch (Exception e) { return s; }
        }

        @JavascriptInterface
        public void clearRecordingFolder() {
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            prefs.edit().remove(KEY_REC_FOLDER).apply();
        }

        /**
         * Persist the phone + leadId of the call the user just initiated through
         * the app. Used both as context for syncCallRecording and as a filter
         * source for "only my calls" mode.
         */
        @JavascriptInterface
        public void registerOutgoingCall(String phone, String leadId, double startedAtMs) {
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            prefs.edit()
                    .putString("last_dialed_phone", phone == null ? "" : phone)
                    .putString("last_dialed_lead_id", leadId == null ? "" : leadId)
                    .putLong("last_dialed_at", (long) startedAtMs)
                    .apply();
            Log.d(TAG, "registered call → " + phone + " lead=" + leadId);
        }

        @JavascriptInterface
        public String getLastDialedCall() {
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            try {
                JSONObject o = new JSONObject();
                o.put("phone", prefs.getString("last_dialed_phone", ""));
                o.put("leadId", prefs.getString("last_dialed_lead_id", ""));
                o.put("dialedAt", prefs.getLong("last_dialed_at", 0));
                return o.toString();
            } catch (Exception e) { return "{}"; }
        }

        @JavascriptInterface
        public String listRecordings(double sinceMs) {
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            String s = prefs.getString(KEY_REC_FOLDER, null);
            if (s == null) return "[]";
            try {
                Uri tree = Uri.parse(s);
                Uri rootDoc = DocumentsContract.buildDocumentUriUsingTree(
                        tree, DocumentsContract.getTreeDocumentId(tree));
                JSONArray arr = new JSONArray();
                listRecursiveSaf(rootDoc, tree, (long) sinceMs, arr, 0);
                return arr.toString();
            } catch (Exception e) {
                Log.e(TAG, "listRecordings: " + e.getMessage());
                return "[]";
            }
        }

        /**
         * Direct-ContentResolver replacement for the old DocumentFile-based
         * recursive walk. On Android 11+ OEM ROMs (Xiaomi, Realme, Vivo,
         * Honor) DocumentFile.listFiles() / getName() routinely return
         * empty / null even when the user has granted persistable URI
         * permission. Querying DocumentsContract directly bypasses that
         * abstraction and gets the actual rows.
         */
        private void listRecursiveSaf(Uri parentDoc, Uri tree, long sinceMs, JSONArray arr, int depth) {
            if (depth > 3) return;
            for (SafEntry e : safList(parentDoc, tree)) {
                try {
                    if (e.isDir) { listRecursiveSaf(e.uri, tree, sinceMs, arr, depth + 1); continue; }
                    if (e.name == null || e.name.isEmpty()) continue;
                    if (!isAudioFile(e.name)) continue;
                    if (e.size <= 0) continue;
                    if (sinceMs > 0 && e.modified > 0 && e.modified < sinceMs) continue;
                    JSONObject o = new JSONObject();
                    o.put("name", e.name);
                    o.put("uri", e.uri.toString());
                    o.put("size", e.size);
                    o.put("modified", e.modified);
                    o.put("mime", e.mime != null ? e.mime : guessMime(e.name));
                    arr.put(o);
                } catch (Exception ignored) {}
            }
        }

        /**
         * Find the single best-matching recording for one specific call (the
         * call the user just made through the app) and upload it. Used right
         * after call_ended fires so the recording shows up in the after-call
         * modal.
         *
         * Matching rule: most recently-modified audio file in the folder
         * whose filename digits include the last 7 digits of `phone`, modified
         * after `sinceMs` (typically the call start time minus a 60s buffer).
         */
        @JavascriptInterface
        public void syncCallRecording(String phone, String leadId, double sinceMs,
                                      String baseUrl, String token, String callback) {
            new Thread(() -> {
                final String cb = callback == null ? "" : callback;
                try {
                    SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
                    String folderUriStr = prefs.getString(KEY_REC_FOLDER, null);
                    if (folderUriStr == null) {
                        invokeJsCallback(cb, false, "no_folder");
                        return;
                    }
                    Uri tree = Uri.parse(folderUriStr);
                    String digits = phone == null ? "" : phone.replaceAll("[^0-9]", "");
                    String tail = digits.length() >= 7 ? digits.substring(digits.length() - 7) : digits;

                    // Direct-ContentResolver SAF walk. Try once, retry once after
                    // 4s (recorder needs time to finalise the file on disk before
                    // SAF can see it).
                    SafEntry best = findBestSafMatch(tree, tail, (long) sinceMs);
                    if (best == null) {
                        Thread.sleep(4000);
                        best = findBestSafMatch(tree, tail, (long) sinceMs);
                    }
                    // Last resort: take the most recent audio file in the folder
                    // ignoring the digit-tail filter. Some OEM recorders
                    // (Realme UI 5+) name files as "Call_<contact>_<datetime>.m4a"
                    // with no embedded phone digits.
                    if (best == null) {
                        best = findBestSafMatch(tree, "", (long) sinceMs);
                    }
                    if (best == null) {
                        invokeJsCallback(cb, false, "no_match");
                        return;
                    }

                    long durationGuess = Math.max(0, (System.currentTimeMillis() - (long) sinceMs) / 1000);
                    String name = best.name != null && !best.name.isEmpty() ? best.name : "recording.m4a";
                    uploadFile(best.uri, name, phone, "out", (int) durationGuess,
                            leadId, String.valueOf((long) sinceMs), baseUrl, token, cb);
                } catch (Exception e) {
                    Log.e(TAG, "syncCallRecording: " + e.getMessage());
                    invokeJsCallback(cb, false, e.getMessage() == null ? "error" : e.getMessage());
                }
            }).start();
        }

        /**
         * Diagnostic: tells the user exactly what we can see in the picked
         * folder. Returns a JSON blob with file count, sample names, and
         * any error encountered. Wire this to a "Test folder access"
         * button on the Diagnostics screen so reps can self-verify.
         */
        @JavascriptInterface
        public String diagnoseRecordingFolder() {
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            String s = prefs.getString(KEY_REC_FOLDER, null);
            JSONObject out = new JSONObject();
            try {
                if (s == null) { out.put("ok", false); out.put("error", "no_folder_picked"); return out.toString(); }
                Uri tree = Uri.parse(s);
                out.put("uri", s);
                out.put("display", humanFolderName(tree));
                Uri rootDoc;
                try {
                    rootDoc = DocumentsContract.buildDocumentUriUsingTree(
                            tree, DocumentsContract.getTreeDocumentId(tree));
                } catch (Exception e) {
                    out.put("ok", false); out.put("error", "bad_tree_uri: " + e.getMessage());
                    return out.toString();
                }
                java.util.List<SafEntry> top = safList(rootDoc, tree);
                int fileCount = 0, audioCount = 0, dirCount = 0;
                JSONArray sample = new JSONArray();
                for (SafEntry e : top) {
                    if (e.isDir) { dirCount++; continue; }
                    fileCount++;
                    if (isAudioFile(e.name)) audioCount++;
                    if (sample.length() < 8) {
                        JSONObject row = new JSONObject();
                        row.put("name", e.name);
                        row.put("mime", e.mime);
                        row.put("size", e.size);
                        row.put("modified", e.modified);
                        sample.put(row);
                    }
                }
                out.put("ok", true);
                out.put("dirs", dirCount);
                out.put("files", fileCount);
                out.put("audioFiles", audioCount);
                out.put("sample", sample);
            } catch (Exception e) {
                try { out.put("ok", false); out.put("error", e.getMessage()); } catch (Exception ignored) {}
            }
            return out.toString();
        }

        @JavascriptInterface
        public void uploadRecordingByUri(String uriStr, String baseUrl, String token,
                                         String phone, String direction, int durationS,
                                         String leadId, String startedAt,
                                         String filename, String callback) {
            new Thread(() -> {
                try {
                    Uri uri = Uri.parse(uriStr);
                    uploadFile(uri, filename, phone, direction, durationS, leadId, startedAt,
                            baseUrl, token, callback);
                } catch (Exception e) {
                    Log.e(TAG, "uploadByUri failed: " + e.getMessage());
                    invokeJsCallback(callback, false, e.getMessage() == null ? "error" : e.getMessage());
                }
            }).start();
        }

        /** Streams a SAF Uri up to /api/recordings as multipart form-data. */
        private void uploadFile(Uri uri, String filename, String phone, String direction,
                                int durationS, String leadId, String startedAt,
                                String baseUrl, String token, String callback) {
            try {
                ContentResolver cr = getContentResolver();
                String name = filename;
                if (name == null || name.isEmpty()) name = "recording.m4a";
                String mime = guessMime(name);
                try (Cursor c = cr.query(uri, null, null, null, null)) {
                    if (c != null && c.moveToFirst()) {
                        int ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                        if (ni >= 0) {
                            String n = c.getString(ni);
                            if (n != null && !n.isEmpty()) name = n;
                        }
                    }
                }
                String t = cr.getType(uri);
                if (t != null) mime = t;

                String boundary = "----LeadCRM" + System.currentTimeMillis();
                URL url = new URL(baseUrl.replaceAll("/+$", "") + "/api/recordings");
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setDoOutput(true);
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(15_000);
                conn.setReadTimeout(180_000);
                conn.setRequestProperty("Connection", "Keep-Alive");
                conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
                conn.setRequestProperty("x-auth-token", token == null ? "" : token);

                DataOutputStream out = new DataOutputStream(new BufferedOutputStream(conn.getOutputStream()));
                writePart(out, boundary, "phone", phone == null ? "" : phone);
                writePart(out, boundary, "direction", direction == null ? "out" : direction);
                writePart(out, boundary, "duration_s", String.valueOf(durationS));
                writePart(out, boundary, "device_path", uri.toString());
                if (startedAt != null && !startedAt.isEmpty())
                    writePart(out, boundary, "started_at", startedAt);
                if (leadId != null && !leadId.isEmpty() && !leadId.equals("null"))
                    writePart(out, boundary, "lead_id", leadId);

                out.writeBytes("--" + boundary + "\r\n");
                out.writeBytes("Content-Disposition: form-data; name=\"audio\"; filename=\"" + name + "\"\r\n");
                out.writeBytes("Content-Type: " + mime + "\r\n\r\n");
                try (InputStream in = cr.openInputStream(uri)) {
                    if (in == null) throw new Exception("cannot open input stream");
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
                out.writeBytes("\r\n");
                out.writeBytes("--" + boundary + "--\r\n");
                out.flush();
                out.close();

                int code = conn.getResponseCode();
                StringBuilder body = new StringBuilder();
                try (BufferedReader r = new BufferedReader(new InputStreamReader(
                        code < 400 ? conn.getInputStream() : conn.getErrorStream(), "UTF-8"))) {
                    String line;
                    while ((line = r.readLine()) != null) body.append(line);
                }
                conn.disconnect();
                Log.d(TAG, "upload " + name + " → " + code + " :: " + body);
                invokeJsCallback(callback, code >= 200 && code < 300, body.toString());
            } catch (Exception e) {
                Log.e(TAG, "uploadFile: " + e.getMessage());
                invokeJsCallback(callback, false, e.getMessage() == null ? "error" : e.getMessage());
            }
        }

        private void writePart(DataOutputStream out, String boundary, String name, String value) throws Exception {
            out.writeBytes("--" + boundary + "\r\n");
            out.writeBytes("Content-Disposition: form-data; name=\"" + name + "\"\r\n\r\n");
            out.write(value.getBytes("UTF-8"));
            out.writeBytes("\r\n");
        }
    }
}
