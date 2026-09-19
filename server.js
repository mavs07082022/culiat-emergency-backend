// ============================================
// Barangay Culiat — Facebook Messenger Emergency Backend
// v5 — Matches real schema (emergencies + hotline_calls)
// ============================================

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json({
    limit: '10mb',
    verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ extended: false, limit: '10mb' }));

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

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_SERVICE_KEY);
const genAI = new GoogleGenerativeAI(CONFIG.GEMINI_API_KEY);

// ============================================
// HEALTH CHECK
// ============================================
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html><head><title>Culiat Emergency Backend</title></head>
        <body style="font-family:system-ui;padding:2rem;max-width:600px;margin:auto;">
            <h1>🚨 Barangay Culiat Emergency Backend</h1>
            <p>Status: <strong style="color:green;">✅ Running</strong></p>
            <p>Server time: ${new Date().toISOString()}</p>
            <h3>Config check:</h3>
            <ul>
                <li>Supabase: ${CONFIG.SUPABASE_URL ? '✅' : '❌'}</li>
                <li>Gemini: ${CONFIG.GEMINI_API_KEY ? '✅' : '❌'}</li>
                <li>Gemini Model: <code>${CONFIG.GEMINI_MODEL}</code></li>
                <li>FB Token: ${CONFIG.FB_PAGE_ACCESS_TOKEN ? '✅' : '❌'}</li>
                <li>FB Secret: ${CONFIG.FB_APP_SECRET ? '✅' : '❌'}</li>
                <li>Signature: ${CONFIG.BYPASS_SIGNATURE ? '⚠️ BYPASSED' : '🔒 Enabled'}</li>
            </ul>
        </body></html>
    `);
});

// ============================================
// FB VERIFICATION
// ============================================
app.get('/webhook/facebook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === CONFIG.FB_VERIFY_TOKEN) {
        console.log('✅ FB Webhook verified!');
        return res.status(200).send(challenge);
    }
    res.sendStatus(403);
});

// ============================================
// FB MESSAGES
// ============================================
app.post('/webhook/facebook', async (req, res) => {
    if (!CONFIG.BYPASS_SIGNATURE && CONFIG.FB_APP_SECRET) {
        if (!verifyFBSignature(req)) return res.sendStatus(403);
    }
    res.status(200).send('EVENT_RECEIVED');
    try {
        const body = req.body;
        if (body.object !== 'page') return;
        for (const entry of body.entry || []) {
            for (const event of entry.messaging || []) {
                await handleFBMessage(event).catch(err => console.error('handleFBMessage error:', err));
            }
        }
    } catch (err) { console.error('Webhook error:', err); }
});

function verifyFBSignature(req) {
    const signature = req.headers['x-hub-signature-256'];
    if (!signature || !req.rawBody) return false;
    const expected = 'sha256=' + crypto
        .createHmac('sha256', CONFIG.FB_APP_SECRET)
        .update(req.rawBody)
        .digest('hex');
    try {
        return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch { return false; }
}

// ============================================
// HANDLE FB MESSAGE
// ============================================
async function handleFBMessage(event) {
    const senderId = event.sender?.id;
    const pageId = event.recipient?.id;
    if (!senderId || !pageId) return;

    if (event.postback) return handlePostback(senderId, event.postback);

    const message = event.message;
    if (!message || message.is_echo) return;

    const text = message.text || '';
    const attachments = message.attachments || [];
    console.log(`💬 FB Message from ${senderId}: "${text}"`);

    await supabase.from('facebook_messages').insert([{
        fb_message_id: message.mid,
        fb_sender_id: senderId,
        fb_page_id: pageId,
        message_text: text,
        attachments: attachments,
        direction: 'inbound',
        raw_payload: event
    }]).select().single();

    const senderName = await getFBSenderName(senderId);

    let { data: session } = await supabase
        .from('facebook_sessions').select('*').eq('fb_sender_id', senderId).maybeSingle();

    if (!session) {
        const { data: newSession } = await supabase
            .from('facebook_sessions').insert([{
                fb_sender_id: senderId,
                fb_sender_name: senderName,
                state: 'idle',
                partial_data: {}
            }]).select().single();
        session = newSession;
    }

    const locationAttach = attachments.find(a => a.type === 'location');
    if (locationAttach?.payload?.coordinates) {
        return handleLocationReceived(senderId, session, locationAttach.payload.coordinates);
    }

    await routeMessage(senderId, senderName, session, text, attachments);
}

const senderNameCache = new Map();
async function getFBSenderName(senderId) {
    if (senderNameCache.has(senderId)) return senderNameCache.get(senderId);
    try {
        const res = await axios.get(
            `https://graph.facebook.com/v18.0/${senderId}`,
            { params: { access_token: CONFIG.FB_PAGE_ACCESS_TOKEN, fields: 'name' }, timeout: 5000 }
        );
        if (res.data.name) {
            senderNameCache.set(senderId, res.data.name);
            return res.data.name;
        }
    } catch (err) {}
    const shortId = senderId.substring(Math.max(0, senderId.length - 6));
    const fallback = `Messenger User #${shortId}`;
    senderNameCache.set(senderId, fallback);
    return fallback;
}

// ============================================
// ROUTE MESSAGE
// ============================================
async function routeMessage(senderId, senderName, session, text, attachments) {
    const lower = text.toLowerCase().trim();

    if (['help', 'tulong', 'menu', 'start'].includes(lower)) return sendFBHelp(senderId);
    if (['status', 'check'].includes(lower)) return sendFBStatus(senderId);
    if (['cancel', 'stop'].includes(lower)) {
        await supabase.from('facebook_sessions').update({ state: 'idle', partial_data: {} }).eq('fb_sender_id', senderId);
        return sendFBMessage(senderId, '✅ Kinansela ang report.');
    }

    if (session.state === 'idle') {
        if (['hi', 'hello', 'hey', 'kumusta', 'kamusta'].includes(lower)) return sendFBWelcome(senderId, senderName);

        const analysis = await analyzeReport(text, attachments);
        console.log('🤖 AI Analysis:', JSON.stringify(analysis));

        if (analysis.isNonsense || analysis.confidence < 0.35) return sendFBCouldNotUnderstand(senderId);

        await supabase.from('facebook_sessions').update({
            state: 'awaiting_name',
            partial_data: { original_text: text, analysis, attachments }
        }).eq('fb_sender_id', senderId);
        return sendFBAskName(senderId, analysis);
    }

    if (session.state === 'awaiting_name') {
        const partial = session.partial_data || {};
        if (text.trim().length < 2) return sendFBMessage(senderId, '❓ Pakisulat ang buong pangalan mo.');
        partial.caller_name = text.trim().substring(0, 80);
        await supabase.from('facebook_sessions').update({ state: 'awaiting_location', partial_data: partial }).eq('fb_sender_id', senderId);
        return sendFBAskLocation(senderId, partial.caller_name);
    }

    if (session.state === 'awaiting_location') {
        const partial = session.partial_data || {};
        if (text.trim().length < 3) return sendFBMessage(senderId, '❓ Pakisabi ang eksaktong lokasyon.');
        partial.location_text = text.trim();
        await supabase.from('facebook_sessions').update({ state: 'awaiting_details', partial_data: partial }).eq('fb_sender_id', senderId);
        return sendFBAskDetails(senderId, partial.location_text);
    }

    if (session.state === 'awaiting_details') {
        const partial = session.partial_data || {};
        partial.additional_details = text.trim();
        const finalText = [partial.original_text, `Lokasyon: ${partial.location_text}`, `Detalye: ${partial.additional_details}`].filter(Boolean).join('\n');
        const analysis = await analyzeReport(finalText, partial.attachments || []);
        return createAndDispatchReport(senderId, partial.caller_name || senderName, finalText, analysis, session, partial);
    }

    await supabase.from('facebook_sessions').update({ state: 'idle', partial_data: {} }).eq('fb_sender_id', senderId);
    sendFBHelp(senderId);
}

// ============================================
// AI ANALYSIS
// ============================================
async function analyzeReport(messageText, attachments = []) {
    const modelsToTry = [CONFIG.GEMINI_MODEL, 'gemini-3.6-flash', 'gemini-2.0-flash-001'].filter(Boolean);
    let lastError = null;

    for (const modelName of modelsToTry) {
        try {
            const model = genAI.getGenerativeModel({
                model: modelName,
                generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
            });

            const prompt = `You are an emergency dispatcher for Barangay Culiat, Quezon City, Philippines.
A resident sent: "${messageText}"

Understand English, Tagalog, Taglish.

Return ONLY this JSON:
{
  "type": "fire" | "medical" | "accident" | "flood" | "crime" | "other",
  "priority": "critical" | "high" | "medium" | "low",
  "location": "extracted location or Unknown",
  "confidence": 0.0,
  "isNonsense": false,
  "suggestedReply": "Short Taglish reply"
}`;

            const result = await model.generateContent(prompt);
            let t = result.response.text().trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(t);

            const validTypes = ['fire', 'medical', 'accident', 'flood', 'crime', 'other'];
            const validPriorities = ['critical', 'high', 'medium', 'low'];

            console.log(`✅ AI analyzed with ${modelName}`);
            return {
                type: validTypes.includes(parsed.type) ? parsed.type : 'other',
                priority: validPriorities.includes(parsed.priority) ? parsed.priority : 'medium',
                location: parsed.location || 'Unknown',
                confidence: Math.min(0.99, Math.max(0, parseFloat(parsed.confidence) || 0.5)),
                isNonsense: !!parsed.isNonsense,
                suggestedReply: parsed.suggestedReply || 'Natanggap namin ang inyong ulat.',
                model: modelName
            };
        } catch (err) {
            lastError = err;
            console.warn(`⚠️ Model ${modelName} failed: ${err.message}`);
        }
    }
    console.error('❌ All Gemini models failed, using rule-based');
    return ruleBasedAnalysis(messageText, lastError);
}

function ruleBasedAnalysis(text, error) {
    const lower = (text || '').toLowerCase();
    const keywords = {
        fire: ['sunog', 'apoy', 'fire', 'nasusunog', 'usok'],
        medical: ['sugat', 'sakit', 'ospital', 'hindi humihinga', 'atake'],
        accident: ['aksidente', 'bangga', 'nasagasaan', 'accident'],
        flood: ['baha', 'pagbaha', 'flood'],
        crime: ['holdap', 'nakaw', 'saksak', 'baril', 'crime']
    };
    let detectedType = 'other', matchCount = 0;
    for (const [type, words] of Object.entries(keywords)) {
        const m = words.filter(w => lower.includes(w)).length;
        if (m > matchCount) { matchCount = m; detectedType = type; }
    }
    const isCritical = ['patay', 'walang malay', 'hindi humihinga', 'sumabog', 'saksak'].some(w => lower.includes(w));
    return {
        type: detectedType,
        priority: isCritical ? 'critical' : (matchCount > 0 ? 'medium' : 'low'),
        location: 'Unknown', confidence: 0.6,
        isNonsense: false,
        suggestedReply: 'Natanggap namin ang inyong ulat. Ive-verify ng aming operator.',
        source: 'rule-based', error: error?.message
    };
}

// ============================================
// LOCATION RECEIVED
// ============================================
async function handleLocationReceived(senderId, session, coords) {
    const partial = session.partial_data || {};
    const originalText = partial.original_text || 'Location shared';
    const analysis = partial.analysis || await analyzeReport(originalText, []);
    analysis.location = `${coords.lat.toFixed(6)}, ${coords.long.toFixed(6)}`;

    return createAndDispatchReport(
        senderId,
        partial.caller_name || session.fb_sender_name || `Messenger User #${senderId.slice(-6)}`,
        originalText,
        analysis,
        session,
        { ...partial, location_text: analysis.location }
    );
}

// ============================================
// CREATE + DISPATCH REPORT (uses emergencies + hotline_calls)
// ============================================
async function createAndDispatchReport(senderId, callerName, fullText, analysis, session, partial) {
    partial = partial || {};
    const finalLocation = partial.location_text || analysis.location || 'Unknown';
    const callerDisplay = callerName || partial.caller_name || session.fb_sender_name || `Messenger User #${senderId.slice(-6)}`;

    let fullDescription = fullText;
    if (partial.additional_details) fullDescription += `\n\n📝 Detalye: ${partial.additional_details}`;
    fullDescription += `\n\n👤 Reporter: ${callerDisplay}\n📱 Via: Facebook Messenger`;

    // 1. Create emergency record
    const { data: emergency, error: emErr } = await supabase
        .from('emergencies')
        .insert([{
            type: analysis.type,
            priority: analysis.priority,
            status: 'reported',
            title: `[FB] ${analysis.type.toUpperCase()} — ${finalLocation}`,
            description: fullDescription,
            location: { address: finalLocation, source: 'facebook' },
            reporter_name: callerDisplay,
            reporter_phone: `FB:${senderId}`,
            source: 'hotline',
            verified_status: 'pending',
            ai_classification: { ...analysis, sender_id: senderId }
        }])
        .select()
        .single();

    if (emErr) console.error('Emergency insert error:', emErr);

    // 2. Create hotline_calls record (links to emergency)
    const { data: hotline, error: hlErr } = await supabase
        .from('hotline_calls')
        .insert([{
            caller_number: `FB:${senderId}`,
            caller_name: callerDisplay,
            description: fullDescription,
            emergency_type: analysis.type,
            priority: analysis.priority,
            status: 'pending',
            call_type: 'facebook',
            incident_location: finalLocation,
            duration: 0,
            emergency_id: emergency?.id
        }])
        .select()
        .single();

    if (hlErr) console.error('Hotline insert error:', hlErr);

    // 3. Reset session
    await supabase.from('facebook_sessions').update({
        state: 'idle',
        partial_data: {}
    }).eq('fb_sender_id', senderId);

    // 4. Reply to user
    const emoji = { critical: '🚨', high: '🟠', medium: '🟡', low: '🔵' }[analysis.priority] || '📋';
    const firstName = callerDisplay.split(' ')[0];
    const reply = `${emoji} **Natanggap na ang report mo, ${firstName}!**

📋 Uri: ${analysis.type.toUpperCase()}
📍 Lokasyon: ${finalLocation}
⚠️ Priority: ${analysis.priority.toUpperCase()}

Naipadala na sa aming responders. Manatiling kalmado at ligtas.

Para sa life-threatening emergency, tumawag din sa **911**.`;

    await sendFBMessage(senderId, reply);
    console.log(`✅ Report: emergency=${emergency?.id}, hotline=${hotline?.id}`);
}

// ============================================
// FB SEND HELPERS
// ============================================
async function sendFBMessage(recipientId, text) {
    try {
        await axios.post(
            `https://graph.facebook.com/v18.0/me/messages`,
            { recipient: { id: recipientId }, messaging_type: 'RESPONSE', message: { text } },
            { params: { access_token: CONFIG.FB_PAGE_ACCESS_TOKEN }, timeout: 10000 }
        );
        console.log(`✉️ FB reply sent to ${recipientId}`);
    } catch (err) {
        console.error('FB send failed:', JSON.stringify(err.response?.data || err.message, null, 2));
    }
}

async function sendFBWelcome(senderId, name) {
    await sendFBMessage(senderId, `👋 Kumusta ${name && !name.startsWith('Messenger User') ? name : 'kaibigan'}! Ako ang **Culiat Emergency Bot**.

Para mag-report: i-type lang ang nangyari. Halimbawa:
• "may sunog sa tandang sora"
• "naaksidente yung motor sa congressional"
• "baha dito sa amin"

Pwede rin magpadala ng 📷 litrato o 📍 live location.

Type **HELP** para sa menu.`);
}

async function sendFBHelp(senderId) {
    await sendFBMessage(senderId, `📞 **Culiat Emergency Bot — Menu**

🚨 **Mag-report:** I-type lang ang emergency
📷 **Mag-attach:** Pwede magpadala ng litrato o location
🔍 **Status:** I-type ang "STATUS"
❌ **Cancel:** I-type ang "CANCEL"

📞 **Tumawag:** 911 o 0962-582-1531`);
}

async function sendFBCouldNotUnderstand(senderId) {
    await sendFBMessage(senderId, `🤔 Hindi ko maintindihan. Subukan ulit:
• Ilarawan ang emergency
• Isama ang lokasyon

Halimbawa: "May aksidente sa tandang sora, may nasugatan"

Para sa urgent, tumawag sa **911**.`);
}

async function sendFBAskName(senderId, analysis) {
    const emoji = { fire: '🔥', medical: '🚑', accident: '🚗', flood: '🌊', crime: '🚨', other: '⚠️' }[analysis.type] || '⚠️';
    const urgency = analysis.priority === 'critical' ? '🚨 CRITICAL EMERGENCY' : 'ℹ️ Emergency Report';

    await sendFBMessage(senderId, `${emoji} ${urgency} natanggap!

Upang maipadala ko sa responders, kailangan ko ng impormasyon:

1️⃣ **Ano ang pangalan mo?**
(Isulat lang ang buong pangalan)

Type "cancel" para kanselahin.`);
}

async function sendFBAskLocation(senderId, callerName) {
    await sendFBMessage(senderId, `Salamat, ${callerName}! ✅

2️⃣ **Saan eksakto nangyari?**
(Street, landmark, o building name)

Pwede rin mag-share ng 📍 LIVE LOCATION gamit ang 📎 attachment icon.`);
}

async function sendFBAskDetails(senderId, location) {
    await sendFBMessage(senderId, `📍 Lokasyon: ${location}

3️⃣ **Karagdagang detalye (opsyonal):**
Ilang tao ang nasa panganib? May nasugatan?

Kung wala na, i-type lang ang "wala".`);
}

async function sendFBStatus(senderId) {
    try {
        const { data: recent } = await supabase
            .from('hotline_calls')
            .select('id, emergency_type, status, priority, created_at')
            .eq('caller_number', `FB:${senderId}`)
            .order('created_at', { ascending: false })
            .limit(3);

        if (!recent || recent.length === 0) return sendFBMessage(senderId, '📭 Walang recent report.');

        const text = recent.map(r => {
            const emoji = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' }[r.priority] || '⚪';
            const date = new Date(r.created_at).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            return `${emoji} **${r.emergency_type?.toUpperCase() || 'N/A'}** — ${r.status}\n   ID: ${r.id.substring(0, 8)} · ${date}`;
        }).join('\n\n');

        await sendFBMessage(senderId, `📋 **Recent Reports:**\n\n${text}`);
    } catch (err) {
        await sendFBMessage(senderId, '⚠️ Hindi ma-check status.');
    }
}

async function handlePostback(senderId, postback) {
    const payload = postback.payload;
    if (payload === 'GET_STARTED') return sendFBWelcome(senderId, await getFBSenderName(senderId));
    if (payload === 'HELP') return sendFBHelp(senderId);
    if (payload === 'STATUS') return sendFBStatus(senderId);
}

// ============================================
// START
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('========================================');
    console.log(`🚀 Server running on port ${PORT}`);
    console.log('Config:');
    console.log('  Supabase:', CONFIG.SUPABASE_URL ? '✅' : '❌');
    console.log('  Gemini:', CONFIG.GEMINI_API_KEY ? '✅' : '❌');
    console.log('  Model:', CONFIG.GEMINI_MODEL);
    console.log('  FB Token:', CONFIG.FB_PAGE_ACCESS_TOKEN ? '✅' : '❌');
    console.log('  FB Secret:', CONFIG.FB_APP_SECRET ? '✅' : '❌');
    console.log('========================================');
});
