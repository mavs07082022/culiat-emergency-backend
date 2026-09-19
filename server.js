// ============================================
// Barangay Culiat — Facebook Messenger Emergency Backend
// v4 — Name-Collection Flow + Raw Body Signature Fix
// ============================================

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();

// ============================================
// MIDDLEWARE — Capture RAW body for signature verification
// ============================================
app.use(express.json({
    limit: '10mb',
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));
app.use(express.urlencoded({ extended: false, limit: '10mb' }));

// ============================================
// CONFIG
// ============================================
const CONFIG = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    FB_PAGE_ACCESS_TOKEN: process.env.FB_PAGE_ACCESS_TOKEN,
    FB_VERIFY_TOKEN: process.env.FB_VERIFY_TOKEN || 'culiat_ecs_verify_2026',
    FB_APP_SECRET: process.env.FB_APP_SECRET,
    GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
    BYPASS_SIGNATURE: process.env.BYPASS_SIGNATURE === 'true',
};

const missing = Object.keys(CONFIG).filter(k => !CONFIG[k] && k !== 'BYPASS_SIGNATURE');
if (missing.length > 0) {
    console.error('❌ Missing environment variables:', missing.join(', '));
}

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_SERVICE_KEY);
const genAI = new GoogleGenerativeAI(CONFIG.GEMINI_API_KEY);

// ============================================
// HEALTH CHECK
// ============================================
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Culiat Emergency Backend</title></head>
        <body style="font-family:system-ui;padding:2rem;max-width:600px;margin:auto;">
            <h1>🚨 Barangay Culiat Emergency Backend</h1>
            <p>Status: <strong style="color:green;">✅ Running</strong></p>
            <p>Server time: ${new Date().toISOString()}</p>
            <h3>Webhooks:</h3>
            <ul>
                <li>GET <code>/webhook/facebook</code> — FB verification</li>
                <li>POST <code>/webhook/facebook</code> — FB messages</li>
            </ul>
            <h3>Config check:</h3>
            <ul>
                <li>Supabase: ${CONFIG.SUPABASE_URL ? '✅' : '❌'}</li>
                <li>Gemini: ${CONFIG.GEMINI_API_KEY ? '✅' : '❌'}</li>
                <li>Gemini Model: <code>${CONFIG.GEMINI_MODEL}</code></li>
                <li>FB Token: ${CONFIG.FB_PAGE_ACCESS_TOKEN ? '✅' : '❌'}</li>
                <li>FB Secret: ${CONFIG.FB_APP_SECRET ? '✅' : '❌'}</li>
                <li>Signature Check: ${CONFIG.BYPASS_SIGNATURE ? '⚠️ BYPASSED' : '🔒 Enabled'}</li>
            </ul>
        </body>
        </html>
    `);
});

// ============================================
// FACEBOOK WEBHOOK — Verification (GET)
// ============================================
app.get('/webhook/facebook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    console.log('🔍 FB Verification attempt:', { mode, token: token ? '✓' : '✗' });

    if (mode === 'subscribe' && token === CONFIG.FB_VERIFY_TOKEN) {
        console.log('✅ FB Webhook verified!');
        return res.status(200).send(challenge);
    }
    console.warn('❌ FB Verification FAILED — token mismatch');
    res.sendStatus(403);
});

// ============================================
// FACEBOOK WEBHOOK — Message Events (POST)
// ============================================
app.post('/webhook/facebook', async (req, res) => {
    if (!CONFIG.BYPASS_SIGNATURE && CONFIG.FB_APP_SECRET) {
        if (!verifyFBSignature(req)) {
            console.warn('⚠️ Invalid FB signature — rejecting');
            return res.sendStatus(403);
        }
    }

    res.status(200).send('EVENT_RECEIVED');

    try {
        const body = req.body;
        if (body.object !== 'page') return;

        for (const entry of body.entry || []) {
            for (const event of entry.messaging || []) {
                await handleFBMessage(event).catch(err =>
                    console.error('handleFBMessage error:', err)
                );
            }
        }
    } catch (err) {
        console.error('FB webhook processing error:', err);
    }
});

function verifyFBSignature(req) {
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) return false;
    if (!req.rawBody) return false;

    const expected = 'sha256=' + crypto
        .createHmac('sha256', CONFIG.FB_APP_SECRET)
        .update(req.rawBody)
        .digest('hex');

    try {
        return crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expected)
        );
    } catch {
        return false;
    }
}

// ============================================
// FACEBOOK MESSAGE HANDLER
// ============================================
async function handleFBMessage(event) {
    const senderId = event.sender?.id;
    const pageId = event.recipient?.id;
    if (!senderId || !pageId) return;

    if (event.postback) {
        return handlePostback(senderId, event.postback);
    }

    const message = event.message;
    if (!message || message.is_echo) return;

    const text = message.text || '';
    const attachments = message.attachments || [];

    console.log(`💬 FB Message from ${senderId}: "${text}" (${attachments.length} attachments)`);

    const { data: savedMsg } = await supabase
        .from('facebook_messages')
        .insert([{
            fb_message_id: message.mid,
            fb_sender_id: senderId,
            fb_page_id: pageId,
            message_text: text,
            attachments: attachments,
            direction: 'inbound',
            raw_payload: event
        }])
        .select()
        .single();

    const senderName = await getFBSenderName(senderId);

    let { data: session } = await supabase
        .from('facebook_sessions')
        .select('*')
        .eq('fb_sender_id', senderId)
        .maybeSingle();

    if (!session) {
        const { data: newSession } = await supabase
            .from('facebook_sessions')
            .insert([{
                fb_sender_id: senderId,
                fb_sender_name: senderName,
                state: 'idle',
                partial_data: {}
            }])
            .select()
            .single();
        session = newSession;
    }

    const locationAttach = attachments.find(a => a.type === 'location');
    if (locationAttach?.payload?.coordinates) {
        return handleLocationReceived(senderId, session, locationAttach.payload.coordinates, savedMsg);
    }

    await routeMessage(senderId, senderName, session, text, attachments, savedMsg);
}

// ============================================
// GET FB SENDER NAME (silent fail with ID fallback)
// ============================================
const senderNameCache = new Map();
async function getFBSenderName(senderId) {
    if (senderNameCache.has(senderId)) return senderNameCache.get(senderId);
    try {
        const res = await axios.get(
            `https://graph.facebook.com/v18.0/${senderId}`,
            {
                params: {
                    access_token: CONFIG.FB_PAGE_ACCESS_TOKEN,
                    fields: 'name'
                },
                timeout: 5000
            }
        );
        const name = res.data.name || null;
        if (name) {
            senderNameCache.set(senderId, name);
            return name;
        }
    } catch (err) {
        // Silent fail — Facebook blocks name lookup without advanced permissions
    }
    // Fallback: unique short ID
    const shortId = senderId.substring(Math.max(0, senderId.length - 6));
    const fallback = `Messenger User #${shortId}`;
    senderNameCache.set(senderId, fallback);
    return fallback;
}

// ============================================
// ROUTE MESSAGE — Main conversation state machine
// ============================================
async function routeMessage(senderId, senderName, session, text, attachments, savedMsg) {
    const lower = text.toLowerCase().trim();

    // Global commands (always work, regardless of state)
    if (['help', 'tulong', 'menu', 'start'].includes(lower)) {
        return sendFBHelp(senderId, senderName);
    }
    if (['status', 'check', 'update'].includes(lower)) {
        return sendFBStatus(senderId);
    }
    if (['cancel', 'stop', 'cancel report'].includes(lower)) {
        await supabase.from('facebook_sessions').update({
            state: 'idle',
            partial_data: {}
        }).eq('fb_sender_id', senderId);
        return sendFBMessage(senderId, '✅ Kinansela ang report. Type "help" para sa menu.');
    }

    // ============================================
    // STATE MACHINE
    // ============================================

    // IDLE — new message
    if (session.state === 'idle') {
        // Greeting detection
        if (['hi', 'hello', 'hey', 'kumusta', 'kamusta', 'good morning', 'good evening'].includes(lower)) {
            return sendFBWelcome(senderId, senderName);
        }

        // Analyze the message
        const analysis = await analyzeReport(text, attachments);
        console.log('🤖 AI Analysis:', JSON.stringify(analysis));

        if (analysis.isNonsense || analysis.confidence < 0.35) {
            return sendFBCouldNotUnderstand(senderId);
        }

        // Emergency detected → ask for name
        await supabase.from('facebook_sessions').update({
            state: 'awaiting_name',
            partial_data: {
                original_text: text,
                analysis: analysis,
                attachments: attachments,
                detected_at: new Date().toISOString()
            }
        }).eq('fb_sender_id', senderId);

        return sendFBAskName(senderId, analysis);
    }

    // AWAITING NAME — user should provide their name
    if (session.state === 'awaiting_name') {
        const partial = session.partial_data || {};
        // Save the name they provided
        const providedName = text.trim().substring(0, 80);
        if (providedName.length < 2) {
            return sendFBMessage(senderId, '❓ Pakisulat ang buong pangalan mo para makapag-report kami.');
        }
        partial.caller_name = providedName;

        await supabase.from('facebook_sessions').update({
            state: 'awaiting_location',
            partial_data: partial
        }).eq('fb_sender_id', senderId);

        return sendFBAskLocation(senderId, providedName);
    }

    // AWAITING LOCATION — user should provide location
    if (session.state === 'awaiting_location') {
        const partial = session.partial_data || {};
        const location = text.trim();

        if (location.length < 3) {
            return sendFBMessage(senderId, '❓ Pakisabi ang eksaktong lokasyon (hal. "may 7-eleven tandang sora").');
        }

        partial.location_text = location;

        await supabase.from('facebook_sessions').update({
            state: 'awaiting_details',
            partial_data: partial
        }).eq('fb_sender_id', senderId);

        return sendFBAskDetails(senderId, location);
    }

    // AWAITING DETAILS — user should provide extra info (optional)
    if (session.state === 'awaiting_details') {
        const partial = session.partial_data || {};
        partial.additional_details = text.trim();

        // Build final text for AI re-analysis
        const finalText = [
            partial.original_text || '',
            partial.location_text ? `Lokasyon: ${partial.location_text}` : '',
            partial.additional_details ? `Detalye: ${partial.additional_details}` : ''
        ].filter(Boolean).join('\n');

        // Re-analyze with all info
        const analysis = await analyzeReport(finalText, partial.attachments || []);

        return createAndDispatchReport(
            senderId,
            partial.caller_name || senderName,
            finalText,
            analysis,
            session,
            savedMsg,
            partial
        );
    }

    // Default — reset and help
    await supabase.from('facebook_sessions').update({
        state: 'idle',
        partial_data: {}
    }).eq('fb_sender_id', senderId);
    sendFBHelp(senderId, senderName);
}

// ============================================
// ASK NAME
// ============================================
async function sendFBAskName(senderId, analysis) {
    const emoji = {
        fire: '🔥', medical: '🚑', accident: '🚗',
        flood: '🌊', crime: '🚨', other: '⚠️'
    }[analysis.type] || '⚠️';

    const urgency = analysis.priority === 'critical'
        ? '🚨 CRITICAL EMERGENCY'
        : analysis.priority === 'high'
            ? '🟠 HIGH PRIORITY'
            : 'ℹ️ Emergency Report';

    await sendFBMessage(
        senderId,
        `${emoji} ${urgency} natanggap!

Upang maipadala ko agad ang report sa responders, kailangan ko ng kaunting impormasyon:

1️⃣ **Ano ang pangalan mo?**
(Isulat lang ang buong pangalan)

Type "cancel" para kanselahin.`
    );
}

// ============================================
// ASK LOCATION
// ============================================
async function sendFBAskLocation(senderId, callerName) {
    await sendFBMessage(
        senderId,
        `Salamat, ${callerName}! ✅

2️⃣ **Saan eksakto nangyari ang emergency?**
(Street, landmark, o building name — hal. "Tandang Sora Ave, tapat ng 7-eleven")

Pwede mo rin i-tap ang 📎 (attachment icon) at i-share ang LIVE LOCATION mo.`
    );
}

// ============================================
// ASK DETAILS (optional)
// ============================================
async function sendFBAskDetails(senderId, location) {
    await sendFBMessage(
        senderId,
        `📍 Lokasyon: ${location}

3️⃣ **Karagdagang detalye (opsyonal):**
Ilang tao ang nasa panganib? Anong klase ng emergency? May nasugatan?

Kung wala na, i-type lang ang "wala" o "none".`
    );
}

// ============================================
// AI ANALYSIS — Gemini with fallback
// ============================================
async function analyzeReport(messageText, attachments = []) {
    const modelsToTry = [
        CONFIG.GEMINI_MODEL,
        'gemini-3.6-flash',
        'gemini-2.0-flash-001'
    ].filter(Boolean);

    let lastError = null;

    for (const modelName of modelsToTry) {
        try {
            const model = genAI.getGenerativeModel({
                model: modelName,
                generationConfig: {
                    temperature: 0.1,
                    responseMimeType: 'application/json'
                }
            });

            const hasMedia = attachments.length > 0;
            const mediaInfo = hasMedia
                ? `The message includes ${attachments.length} attachment(s): ${attachments.map(a => a.type).join(', ')}.`
                : '';

            const prompt = `You are an emergency dispatcher for Barangay Culiat, Quezon City, Philippines.

A resident sent this via Facebook Messenger: "${messageText}"
${mediaInfo}

The resident may write in English, Tagalog, or Taglish.

Examples:
- "may sunog sa kanto namin"
- "naaksidente yung motor sa tandang sora"
- "baha na dito sa congressional"
- "may holdap sa 7-eleven"
- "hindi humihinga yung kapitbahay ko"

TASK 1 — TYPE: "fire" | "medical" | "accident" | "flood" | "crime" | "other"
TASK 2 — PRIORITY:
  - "critical": Life-threatening (unconscious, trapped, explosion, shooting, drowning)
  - "high": Serious (major accident, rising flood, robbery, severe injury)
  - "medium": Needs attention (minor injury, disturbance, fallen tree)
  - "low": Non-urgent, test, or gibberish
TASK 3 — LOCATION: Extract street/landmark (string, or "Unknown")
TASK 4 — CONFIDENCE: 0.0 to 1.0
TASK 5 — IS_NONSENSE: true if gibberish or greeting only
TASK 6 — SUGGESTED_REPLY: Short Taglish reply (max 200 chars)

Return ONLY this JSON (no markdown):
{
  "type": "fire",
  "priority": "critical",
  "location": "Tandang Sora Ave",
  "confidence": 0.92,
  "isNonsense": false,
  "suggestedReply": "Natanggap namin ang ulat ng sunog. Padating na ang responders."
}`;

            const result = await model.generateContent(prompt);
            let text = result.response.text().trim();
            text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(text);

            const validTypes = ['fire', 'medical', 'accident', 'flood', 'crime', 'other'];
            const validPriorities = ['critical', 'high', 'medium', 'low'];

            console.log(`✅ AI analyzed with ${modelName}`);

            return {
                type: validTypes.includes(parsed.type) ? parsed.type : 'other',
                priority: validPriorities.includes(parsed.priority) ? parsed.priority : 'medium',
                location: parsed.location || 'Unknown',
                confidence: Math.min(0.99, Math.max(0.0, parseFloat(parsed.confidence) || 0.5)),
                isNonsense: !!parsed.isNonsense,
                suggestedReply: parsed.suggestedReply || 'Natanggap namin ang inyong ulat.',
                model: modelName
            };
        } catch (err) {
            lastError = err;
            console.warn(`⚠️ Model ${modelName} failed: ${err.message}`);
            continue;
        }
    }

    console.error('❌ All Gemini models failed, using rule-based fallback');
    return ruleBasedAnalysis(messageText, lastError);
}

// ============================================
// RULE-BASED FALLBACK
// ============================================
function ruleBasedAnalysis(text, error) {
    const lower = (text || '').toLowerCase();

    const keywords = {
        fire: ['sunog', 'apoy', 'fire', 'nasusunog', 'usok', 'nagniningas'],
        medical: ['sugat', 'sakit', 'ospital', 'hindi humihinga', 'atake', 'medical', 'ambulance', 'dugo', 'nahihilo'],
        accident: ['aksidente', 'bangga', 'nasagasaan', 'accident', 'crash', 'nahulog'],
        flood: ['baha', 'pagbaha', 'flood', 'tubig', 'lunod'],
        crime: ['holdap', 'nakaw', 'saksak', 'baril', 'away', 'crime', 'robbery', 'theft']
    };

    const criticalWords = ['patay', 'walang malay', 'hindi humihinga', 'explosion', 'sumabog', 'baril', 'saksak'];

    let detectedType = 'other';
    let matchCount = 0;

    for (const [type, words] of Object.entries(keywords)) {
        const matches = words.filter(w => lower.includes(w)).length;
        if (matches > matchCount) {
            matchCount = matches;
            detectedType = type;
        }
    }

    const isCritical = criticalWords.some(w => lower.includes(w));
    const priority = isCritical ? 'critical' : (matchCount > 0 ? 'medium' : 'low');

    return {
        type: detectedType,
        priority: priority,
        location: 'Unknown',
        confidence: 0.6,
        isNonsense: false,
        suggestedReply: 'Natanggap namin ang inyong ulat. Ive-verify ng aming operator.',
        source: 'rule-based',
        error: error?.message
    };
}

// ============================================
// LOCATION RECEIVED (shared location attachment)
// ============================================
async function handleLocationReceived(senderId, session, coords, savedMsg) {
    const lat = coords.lat;
    const lng = coords.long;
    const partial = session.partial_data || {};
    const originalText = partial.original_text || 'Location shared via Messenger';
    const callerName = partial.caller_name || session.fb_sender_name || `Messenger User #${senderId.substring(senderId.length - 6)}`;

    const analysis = partial.analysis || await analyzeReport(originalText, []);

    const combinedLocation = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    analysis.location = combinedLocation;

    // If we were asking for name and got a location instead — still capture location
    const finalName = callerName;

    return createAndDispatchReport(
        senderId,
        finalName,
        originalText + `\n📍 Location: ${combinedLocation}`,
        analysis,
        session,
        savedMsg,
        { ...partial, location_text: combinedLocation }
    );
}

// ============================================
// CREATE + DISPATCH REPORT
// ============================================
async function createAndDispatchReport(senderId, callerName, fullText, analysis, session, savedMsg, partial) {
    partial = partial || {};

    // Build final location
    const finalLocation = partial.location_text || analysis.location || 'Unknown';
    const additionalDetails = partial.additional_details || '';
    const callerDisplay = callerName || partial.caller_name || session.fb_sender_name || `Messenger User #${senderId.substring(senderId.length - 6)}`;

    // Compose full description
    let fullDescription = fullText;
    if (additionalDetails && !fullText.includes(additionalDetails)) {
        fullDescription += `\n\n📝 Karagdagang Detalye: ${additionalDetails}`;
    }
    fullDescription += `\n\n👤 Reporter: ${callerDisplay}\n📱 Via: Facebook Messenger`;

    // Create incident report
    const { data: incident } = await supabase
        .from('incident_reports')
        .insert([{
            type: analysis.type,
            title: `[FB] ${analysis.type.toUpperCase()} — ${finalLocation}`,
            description: fullDescription,
            location: JSON.stringify({ address: finalLocation }),
            contact_number: `FB:${senderId}`,
            priority: analysis.priority,
            status: 'reported',
            barangay: 'Culiat',
            ai_analysis: {
                ...analysis,
                source: 'facebook_messenger',
                sender_id: senderId,
                caller_name: callerDisplay
            }
        }])
        .select()
        .single();

    // Create hotline call record
    const { data: hotline } = await supabase
        .from('hotline_calls')
        .insert([{
            caller_name: callerDisplay,
            caller_contact: `FB:${senderId}`,
            call_type: 'text',
            emergency_type: analysis.type,
            incident_location: finalLocation,
            description: fullDescription,
            priority: analysis.priority,
            status: 'received',
            linked_incident_id: incident?.id,
            notes: `Via Facebook Messenger. Confidence: ${(analysis.confidence * 100).toFixed(0)}%`
        }])
        .select()
        .single();

    // Link message to records
    if (savedMsg && hotline) {
        await supabase.from('facebook_messages')
            .update({
                linked_incident_id: incident?.id,
                linked_hotline_id: hotline.id,
                parsed_type: analysis.type,
                parsed_priority: analysis.priority,
                parsed_location: finalLocation
            })
            .eq('id', savedMsg.id);
    }

    // Reset session
    await supabase.from('facebook_sessions').update({
        state: 'idle',
        partial_data: {}
    }).eq('fb_sender_id', senderId);

    // Reply to user
    const priorityEmoji = {
        critical: '🚨', high: '🟠', medium: '🟡', low: '🔵'
    }[analysis.priority] || '📋';

    const confirmationReply = `${priorityEmoji} **Natanggap na ang report mo, ${callerDisplay.split(' ')[0]}!**

📋 Uri: ${analysis.type.toUpperCase()}
📍 Lokasyon: ${finalLocation}
⚠️ Priority: ${analysis.priority.toUpperCase()}

Ang iyong report ay naipadala na sa aming responders. Manatiling kalmado at ligtas. Kung may karagdagang impormasyon, i-type lang dito.

Para sa life-threatening emergency, tumawag din sa **911**.`;

    await sendFBMessage(senderId, confirmationReply);

    console.log(`✅ Report created: ${incident?.id} (${analysis.type}/${analysis.priority}) by ${callerDisplay}`);
}

// ============================================
// FACEBOOK SEND HELPERS
// ============================================
async function sendFBMessage(recipientId, text) {
    try {
        await axios.post(
            `https://graph.facebook.com/v18.0/me/messages`,
            {
                recipient: { id: recipientId },
                messaging_type: 'RESPONSE',
                message: { text: text }
            },
            {
                params: { access_token: CONFIG.FB_PAGE_ACCESS_TOKEN },
                timeout: 10000
            }
        );
        console.log(`✉️ FB reply sent to ${recipientId}`);
    } catch (err) {
        const errData = err.response?.data || err.message;
        console.error('FB send failed:', JSON.stringify(errData, null, 2));
    }
}

async function sendFBWelcome(senderId, name) {
    const displayName = (name && !name.startsWith('Messenger User')) ? name : 'kaibigan';

    const text = `👋 Kumusta ${displayName}! Ako ang **Culiat Emergency Bot** — ang inyong katuwang sa emergency.

**Para mag-report ng emergency:**
I-type lang kung ano ang nangyari. Halimbawa:
• "may sunog sa tandang sora"
• "naaksidente yung motor sa congressional"
• "baha dito sa kanto namin"
• "may holdap sa 7-eleven"

**Pwede rin magpadala ng:**
📷 Litrato o video
📍 Live location

Tutulungan kita sa pag-report at padadalhan agad ng responders. 🚨

⚠️ Para sa life-threatening emergency, tumawag din sa **911** o **0962-582-1531**.

Type **HELP** para sa menu.`;

    await sendFBMessage(senderId, text);
}

async function sendFBHelp(senderId, name) {
    const text = `📞 **Culiat Emergency Bot — Menu**

**🚨 Mag-report:**
I-type lang ang emergency (hal. "may sunog sa...")
Sasagutin ka ng bot at hihingin ang ilang detalye.

**📷 Mag-attach:**
Pwede magpadala ng litrato, video, o location

**🔍 Status:**
I-type ang "STATUS" para makita ang recent reports mo

**❌ Cancel:**
I-type ang "CANCEL" para kanselahin ang kasalukuyang report

**📞 Tumawag:**
911 o 0962-582-1531 (para sa urgent)

⚠️ Para sa life-threatening emergencies, tumawag agad sa **911**.`;

    await sendFBMessage(senderId, text);
}

async function sendFBCouldNotUnderstand(senderId) {
    await sendFBMessage(
        senderId,
        `🤔 Hindi ko maintindihan ang mensahe mo.

**Subukan ulit:**
• Ilarawan ang emergency (hal. "may sunog sa...")
• Isama ang lokasyon
• Pwede magpadala ng litrato o location

**Halimbawa:**
"May aksidente sa tandang sora, may nasugatan"

Para sa urgent, tumawag sa **911**.`
    );
}

async function sendFBStatus(senderId) {
    try {
        const { data: recent } = await supabase
            .from('hotline_calls')
            .select('id, emergency_type, status, priority, created_at')
            .eq('caller_contact', `FB:${senderId}`)
            .order('created_at', { ascending: false })
            .limit(3);

        if (!recent || recent.length === 0) {
            return sendFBMessage(senderId, '📭 Wala kaming natagpuang recent report mula sa iyo.');
        }

        const text = recent.map(r => {
            const emoji = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' }[r.priority] || '⚪';
            const date = new Date(r.created_at).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            return `${emoji} **${r.emergency_type.toUpperCase()}** — ${r.status.replace('_', ' ')}\n   ID: ${r.id.substring(0, 8)} · ${date}`;
        }).join('\n\n');

        await sendFBMessage(senderId, `📋 **Recent Reports:**\n\n${text}`);
    } catch (err) {
        await sendFBMessage(senderId, '⚠️ Hindi ma-check status ngayon.');
    }
}

async function handlePostback(senderId, postback) {
    const payload = postback.payload;
    console.log(`🔘 Postback: ${payload}`);

    if (payload === 'GET_STARTED') {
        const name = await getFBSenderName(senderId);
        return sendFBWelcome(senderId, name);
    }
    if (payload === 'HELP') return sendFBHelp(senderId);
    if (payload === 'STATUS') return sendFBStatus(senderId);
}

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('========================================');
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 FB Webhook: GET/POST /webhook/facebook`);
    console.log('========================================');
    console.log('Config status:');
    console.log('  Supabase:', CONFIG.SUPABASE_URL ? '✅' : '❌');
    console.log('  Gemini:', CONFIG.GEMINI_API_KEY ? '✅' : '❌');
    console.log('  Gemini Model:', CONFIG.GEMINI_MODEL);
    console.log('  FB Token:', CONFIG.FB_PAGE_ACCESS_TOKEN ? '✅' : '❌');
    console.log('  FB Secret:', CONFIG.FB_APP_SECRET ? '✅' : '❌');
    console.log('  Signature Check:', CONFIG.BYPASS_SIGNATURE ? '⚠️ BYPASSED' : '🔒 Enabled');
    console.log('========================================');
});
