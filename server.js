// ============================================
// Barangay Culiat — Facebook Messenger Emergency Backend
// Receives FB messages → AI parse → save to Supabase → reply
// ============================================

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '10mb' }));

// ============================================
// CONFIG (from environment variables)
// ============================================
const CONFIG = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    FB_PAGE_ACCESS_TOKEN: process.env.FB_PAGE_ACCESS_TOKEN,
    FB_VERIFY_TOKEN: process.env.FB_VERIFY_TOKEN || 'culiat_ecs_verify_2026',
    FB_APP_SECRET: process.env.FB_APP_SECRET,
};

// Validate config on startup
const missing = Object.keys(CONFIG).filter(k => !CONFIG[k]);
if (missing.length > 0) {
    console.error('❌ Missing environment variables:', missing.join(', '));
    console.error('Set them in Railway → Variables tab');
}

// Initialize clients
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
                <li>FB Token: ${CONFIG.FB_PAGE_ACCESS_TOKEN ? '✅' : '❌'}</li>
                <li>FB Secret: ${CONFIG.FB_APP_SECRET ? '✅' : '❌'}</li>
            </ul>
        </body>
        </html>
    `);
});

// ============================================
// FACEBOOK WEBHOOK — Verification (GET)
// Facebook calls this once when you set up the webhook
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
    // Verify signature
    const signature = req.headers['x-hub-signature-256'];
    if (CONFIG.FB_APP_SECRET && !verifyFBSignature(req.body, signature)) {
        console.warn('⚠️ Invalid FB signature — rejecting');
        return res.sendStatus(403);
    }

    // Respond immediately (FB needs < 15s)
    res.status(200).send('EVENT_RECEIVED');

    // Process async
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

function verifyFBSignature(body, signature) {
    if (!signature) return false;
    const expected = 'sha256=' + crypto
        .createHmac('sha256', CONFIG.FB_APP_SECRET)
        .update(JSON.stringify(body))
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

    // Postback (button click)
    if (event.postback) {
        return handlePostback(senderId, event.postback);
    }

    const message = event.message;
    if (!message || message.is_echo) return;

    const text = message.text || '';
    const attachments = message.attachments || [];

    console.log(`💬 FB Message from ${senderId}: "${text}" (${attachments.length} attachments)`);

    // Save raw message
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

    // Get sender name
    const senderName = await getFBSenderName(senderId);

    // Get or create session
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

    // Handle location attachment
    const locationAttach = attachments.find(a => a.type === 'location');
    if (locationAttach?.payload?.coordinates) {
        return handleLocationReceived(senderId, session, locationAttach.payload.coordinates, savedMsg);
    }

    // Route by session state
    await routeMessage(senderId, senderName, session, text, attachments, savedMsg);
}

// ============================================
// GET FB SENDER NAME (cached)
// ============================================
const senderNameCache = new Map();
async function getFBSenderName(senderId) {
    if (senderNameCache.has(senderId)) return senderNameCache.get(senderId);
    try {
        const res = await axios.get(
            `https://graph.facebook.com/v18.0/${senderId}`,
            { params: { access_token: CONFIG.FB_PAGE_ACCESS_TOKEN, fields: 'first_name,last_name' } }
        );
        const name = `${res.data.first_name || ''} ${res.data.last_name || ''}`.trim() || 'Resident';
        senderNameCache.set(senderId, name);
        return name;
    } catch (err) {
        console.warn('Could not fetch FB name:', err.message);
        return 'Resident';
    }
}

// ============================================
// ROUTE MESSAGE
// ============================================
async function routeMessage(senderId, senderName, session, text, attachments, savedMsg) {
    const lower = text.toLowerCase().trim();

    // Global commands
    if (['help', 'tulong', 'menu', 'start'].includes(lower)) {
        return sendFBHelp(senderId, senderName);
    }
    if (['status', 'check', 'update'].includes(lower)) {
        return sendFBStatus(senderId);
    }

    // Idle state
    if (session.state === 'idle') {
        if (['hi', 'hello', 'hey', 'kumusta', 'kamusta'].includes(lower)) {
            return sendFBWelcome(senderId, senderName);
        }

        const analysis = await analyzeReport(text, attachments);
        console.log('🤖 AI Analysis:', JSON.stringify(analysis));

        if (analysis.isNonsense || analysis.confidence < 0.4) {
            return sendFBCouldNotUnderstand(senderId);
        }

        // Critical + has location → auto-dispatch
        if (analysis.priority === 'critical' && analysis.location && analysis.location !== 'Unknown') {
            return createAndDispatchReport(senderId, senderName, text, analysis, session, savedMsg);
        }

        // Ask for location
        await supabase.from('facebook_sessions').update({
            state: 'awaiting_location',
            partial_data: {
                original_text: text,
                analysis: analysis,
                attachments: attachments
            }
        }).eq('fb_sender_id', senderId);

        return sendFBAwaitingLocation(senderId, analysis);
    }

    // Awaiting location
    if (session.state === 'awaiting_location') {
        const partial = session.partial_data || {};
        partial.location_text = text;
        const combinedText = (partial.original_text || '') + ' sa ' + text;
        const analysis = await analyzeReport(combinedText, partial.attachments || []);
        return createAndDispatchReport(senderId, senderName, combinedText, analysis, session, savedMsg);
    }

    sendFBHelp(senderId, senderName);
}

// ============================================
// AI ANALYSIS
// ============================================
async function analyzeReport(messageText, attachments = []) {
    try {
        const model = genAI.getGenerativeModel({
            model: 'gemini-2.0-flash',
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

        return {
            type: validTypes.includes(parsed.type) ? parsed.type : 'other',
            priority: validPriorities.includes(parsed.priority) ? parsed.priority : 'medium',
            location: parsed.location || 'Unknown',
            confidence: Math.min(0.99, Math.max(0.0, parseFloat(parsed.confidence) || 0.5)),
            isNonsense: !!parsed.isNonsense,
            suggestedReply: parsed.suggestedReply || 'Natanggap namin ang inyong ulat.'
        };
    } catch (err) {
        console.error('AI analysis error:', err.message);
        return {
            type: 'other',
            priority: 'medium',
            location: 'Unknown',
            confidence: 0.5,
            isNonsense: false,
            suggestedReply: 'Natanggap namin ang inyong mensahe. Ive-verify ng aming operator.',
            error: err.message
        };
    }
}

// ============================================
// LOCATION RECEIVED
// ============================================
async function handleLocationReceived(senderId, session, coords, savedMsg) {
    const lat = coords.lat;
    const lng = coords.long;
    const partial = session.partial_data || {};
    const originalText = partial.original_text || 'Location shared via Messenger';
    const analysis = partial.analysis || await analyzeReport(originalText, []);

    analysis.location = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;

    const { data: incident } = await supabase
        .from('incident_reports')
        .insert([{
            type: analysis.type,
            title: `[FB] ${analysis.type.toUpperCase()} — Messenger Report`,
            description: originalText + `\n\n📍 Shared location: ${lat}, ${lng}`,
            location: JSON.stringify({
                address: originalText || 'Shared via Messenger',
                latitude: lat,
                longitude: lng
            }),
            contact_number: 'Messenger',
            priority: analysis.priority,
            status: 'reported',
            barangay: 'Culiat',
            ai_analysis: { ...analysis, source: 'facebook_messenger', sender_id: senderId }
        }])
        .select()
        .single();

    const { data: hotline } = await supabase
        .from('hotline_calls')
        .insert([{
            caller_name: session.fb_sender_name || 'Messenger User',
            caller_contact: `FB:${senderId}`,
            call_type: 'text',
            emergency_type: analysis.type,
            incident_location: `${lat}, ${lng}`,
            incident_latitude: lat,
            incident_longitude: lng,
            description: originalText,
            priority: analysis.priority,
            status: 'verified',
            linked_incident_id: incident?.id,
            notes: `Auto-parsed from FB Messenger. Confidence: ${analysis.confidence}`
        }])
        .select()
        .single();

    if (savedMsg && hotline) {
        await supabase.from('facebook_messages')
            .update({
                linked_incident_id: incident?.id,
                linked_hotline_id: hotline.id,
                parsed_type: analysis.type,
                parsed_priority: analysis.priority,
                parsed_location: `${lat}, ${lng}`
            })
            .eq('id', savedMsg.id);
    }

    await supabase.from('facebook_sessions').update({
        state: 'idle',
        partial_data: {}
    }).eq('fb_sender_id', senderId);

    const reply = analysis.priority === 'critical'
        ? `🚨 Natanggap namin ang emergency report (${analysis.type.toUpperCase()}). AGAD na ipapadala ang responders. Manatiling ligtas.`
        : `✅ Natanggap namin ang report mo (${analysis.type}). Ive-verify ng aming operator. Salamat!`;

    await sendFBMessage(senderId, reply);
}

// ============================================
// CREATE + DISPATCH REPORT
// ============================================
async function createAndDispatchReport(senderId, senderName, fullText, analysis, session, savedMsg) {
    const { data: incident } = await supabase
        .from('incident_reports')
        .insert([{
            type: analysis.type,
            title: `[FB] ${analysis.type.toUpperCase()} — ${analysis.location}`,
            description: fullText,
            location: JSON.stringify({ address: analysis.location }),
            contact_number: `FB:${senderId}`,
            priority: analysis.priority,
            status: 'reported',
            barangay: 'Culiat',
            ai_analysis: { ...analysis, source: 'facebook_messenger', sender_id: senderId }
        }])
        .select()
        .single();

    const { data: hotline } = await supabase
        .from('hotline_calls')
        .insert([{
            caller_name: senderName || 'Messenger User',
            caller_contact: `FB:${senderId}`,
            call_type: 'text',
            emergency_type: analysis.type,
            incident_location: analysis.location,
            description: fullText,
            priority: analysis.priority,
            status: 'received',
            linked_incident_id: incident?.id,
            notes: `Auto-parsed from FB Messenger. Confidence: ${analysis.confidence}`
        }])
        .select()
        .single();

    if (savedMsg && hotline) {
        await supabase.from('facebook_messages')
            .update({
                linked_incident_id: incident?.id,
                linked_hotline_id: hotline.id,
                parsed_type: analysis.type,
                parsed_priority: analysis.priority,
                parsed_location: analysis.location
            })
            .eq('id', savedMsg.id);
    }

    await supabase.from('facebook_sessions').update({
        state: 'idle',
        partial_data: {}
    }).eq('fb_sender_id', senderId);

    await sendFBMessage(senderId, analysis.suggestedReply);
}

// ============================================
// FACEBOOK SEND HELPERS
// ============================================
async function sendFBMessage(recipientId, text, quickReplies = null) {
    try {
        const payload = {
            recipient: { id: recipientId },
            message: { text: text }
        };
        if (quickReplies) {
            payload.message.quick_replies = quickReplies;
        }
        await axios.post(
            `https://graph.facebook.com/v18.0/me/messages`,
            payload,
            { params: { access_token: CONFIG.FB_PAGE_ACCESS_TOKEN } }
        );
        console.log(`✉️ FB reply sent to ${recipientId}`);
    } catch (err) {
        console.error('FB send failed:', err.response?.data || err.message);
    }
}

async function sendFBWelcome(senderId, name) {
    const text = `👋 Kumusta ${name || ''}! Ako ang Culiat Emergency Bot.

Para mag-report ng emergency, i-type lang kung ano ang nangyari. Halimbawa:
• "may sunog sa tandang sora"
• "naaksidente yung motor sa congressional"
• "baha dito sa kanto namin"
• "may holdap sa 7-eleven"

Pwede rin magpadala ng litrato, video, o location. 🚨

Type HELP para sa menu.`;

    await sendFBMessage(senderId, text);
}

async function sendFBHelp(senderId, name) {
    const text = `📞 Culiat Emergency Bot — Menu

• Mag-report: i-type lang ang emergency
• Mag-attach: pwede magpadala ng litrato, video, o location
• Status: i-type ang "STATUS"
• Tumawag: 911 o 0962-582-1531

⚠️ Para sa life-threatening emergencies, tumawag agad sa 911.`;

    await sendFBMessage(senderId, text);
}

async function sendFBCouldNotUnderstand(senderId) {
    await sendFBMessage(
        senderId,
        `🤔 Hindi ko maintindihan ang mensahe mo.

Subukan ulit:
• Ilarawan ang emergency (hal. "may sunog sa...")
• Isama ang lokasyon
• Pwede magpadala ng litrato o location

Para sa urgent, tumawag sa 911.`
    );
}

async function sendFBAwaitingLocation(senderId, analysis) {
    const emoji = {
        fire: '🔥', medical: '🚑', accident: '🚗',
        flood: '🌊', crime: '🚨', other: '⚠️'
    }[analysis.type] || '⚠️';

    await sendFBMessage(
        senderId,
        `${emoji} Natanggap ko ang ulat mo na ${analysis.type}.

📍 SAAN ito nangyari?
Pakisagot ang lokasyon (street, landmark, o building).

O kaya i-tap ang 📎 at i-share ang live location.`,
        [{ content_type: 'location' }]
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
            return `${emoji} ${r.emergency_type.toUpperCase()} — ${r.status.replace('_', ' ')}\nID: ${r.id.substring(0, 8)}`;
        }).join('\n\n');

        await sendFBMessage(senderId, `📋 Recent Reports:\n\n${text}`);
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
    console.log('  FB Token:', CONFIG.FB_PAGE_ACCESS_TOKEN ? '✅' : '❌');
    console.log('  FB Secret:', CONFIG.FB_APP_SECRET ? '✅' : '❌');
    console.log('========================================');
});
