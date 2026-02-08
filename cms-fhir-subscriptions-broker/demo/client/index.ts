// IAS Client (:3001)
const PORT = 3001;
const BROKER = "http://localhost:3002";

// --- Accumulated state ---
const state = {
  identity: null as null | { verified: boolean; name: string; phone: string; steps: string[] },
  token: null as null | { access_token: string; patient: string },
  subscriptions: [] as any[],
  notifications: [] as any[],
  encounters: [] as any[],
  events: [] as any[],
};

// SSE connections
const sseClients: Set<ReadableStreamDefaultController> = new Set();

function pushEvent(data: any) {
  data.timestamp = Date.now();
  state.events.push(data);
  // Keep last 200
  if (state.events.length > 200) state.events.shift();
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    try {
      c.enqueue(new TextEncoder().encode(msg));
    } catch {
      sseClients.delete(c);
    }
  }
}

// Serve HTML UI
const uiHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>IAS Client — Identity Verification</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0d1b2a;
    color: #e0e0e0;
    min-height: 100vh;
  }
  header {
    background: #1a3a5c;
    padding: 16px 24px;
    border-bottom: 2px solid #3498db;
    display: flex;
    align-items: center;
    gap: 16px;
  }
  header h1 { font-size: 1.3rem; color: #85c1e9; }
  header .subtitle { font-size: 0.85rem; color: #5dade2; }
  .container {
    max-width: 600px;
    margin: 24px auto;
    padding: 0 16px;
  }
  .card {
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(52,152,219,0.3);
    border-radius: 8px;
    padding: 24px;
    margin-bottom: 16px;
  }
  .card h2 { font-size: 1.1rem; margin-bottom: 16px; color: #85c1e9; }
  .step-indicator {
    display: flex;
    gap: 8px;
    margin-bottom: 24px;
  }
  .step-dot {
    flex: 1;
    height: 4px;
    border-radius: 2px;
    background: rgba(255,255,255,0.1);
    transition: background 0.3s;
  }
  .step-dot.active { background: #3498db; }
  .step-dot.done { background: #2ecc71; }
  .form-group { margin-bottom: 16px; }
  .form-group label {
    display: block;
    font-size: 0.85rem;
    color: #8899aa;
    margin-bottom: 6px;
  }
  .form-group input, .form-group select {
    width: 100%;
    padding: 10px 12px;
    border-radius: 6px;
    border: 1px solid rgba(255,255,255,0.2);
    background: rgba(0,0,0,0.3);
    color: #eee;
    font-size: 0.95rem;
  }
  .form-group input:focus { outline: 2px solid #3498db; border-color: transparent; }
  button {
    border: none;
    padding: 12px 24px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.95rem;
    font-weight: 600;
    transition: all 0.2s;
    width: 100%;
  }
  button:hover { opacity: 0.9; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-primary { background: #3498db; color: #fff; }
  .btn-success { background: #27ae60; color: #fff; }
  .upload-zone {
    border: 2px dashed rgba(52,152,219,0.4);
    border-radius: 8px;
    padding: 32px;
    text-align: center;
    color: #5dade2;
    cursor: pointer;
    transition: all 0.2s;
    margin-bottom: 16px;
  }
  .upload-zone:hover { border-color: #3498db; background: rgba(52,152,219,0.05); }
  .upload-zone.uploaded { border-color: #27ae60; background: rgba(39,174,96,0.05); color: #2ecc71; }
  .upload-icon { font-size: 2rem; margin-bottom: 8px; }
  .spinner {
    display: inline-block;
    width: 20px;
    height: 20px;
    border: 3px solid rgba(255,255,255,0.3);
    border-radius: 50%;
    border-top-color: #fff;
    animation: spin 0.8s linear infinite;
    margin-right: 8px;
    vertical-align: middle;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .success-check {
    color: #2ecc71;
    font-size: 3rem;
    text-align: center;
    margin: 16px 0;
  }
  .status-section {
    margin-top: 24px;
    padding: 16px;
    background: rgba(0,0,0,0.3);
    border-radius: 8px;
  }
  .status-section h3 { font-size: 0.9rem; color: #8899aa; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
  .status-item {
    display: flex;
    justify-content: space-between;
    padding: 6px 0;
    border-bottom: 1px solid rgba(255,255,255,0.05);
    font-size: 0.85rem;
  }
  .status-item:last-child { border-bottom: none; }
  .tag { padding: 2px 8px; border-radius: 10px; font-size: 0.7rem; font-weight: 600; }
  .tag-green { background: rgba(39,174,96,0.2); color: #2ecc71; }
  .tag-blue { background: rgba(52,152,219,0.2); color: #5dade2; }
  .tag-amber { background: rgba(230,126,34,0.2); color: #f0b27a; }
  .encounter-card {
    background: rgba(39,174,96,0.08);
    border: 1px solid rgba(39,174,96,0.2);
    border-radius: 6px;
    padding: 12px;
    margin-top: 8px;
    font-size: 0.85rem;
  }
  .encounter-card .enc-title { font-weight: 600; color: #82e0aa; }
  .encounter-card .enc-detail { color: #aaa; font-size: 0.8rem; }
  details { margin-top: 8px; }
  details summary { cursor: pointer; font-size: 0.8rem; color: #5dade2; }
  details pre {
    background: rgba(0,0,0,0.4);
    padding: 8px;
    border-radius: 4px;
    font-size: 0.72rem;
    overflow-x: auto;
    margin-top: 4px;
    color: #aaccee;
    max-height: 200px;
    overflow-y: auto;
  }
  #knowledge-section { display: none; }
</style>
</head>
<body>

<header>
  <h1>IAS Client</h1>
  <span class="subtitle">Identity-Assured Subscriber</span>
</header>

<div class="container">
  <!-- ID Proofing Wizard -->
  <div id="wizard">
    <div class="step-indicator">
      <div class="step-dot" id="sd-1"></div>
      <div class="step-dot" id="sd-2"></div>
      <div class="step-dot" id="sd-3"></div>
      <div class="step-dot" id="sd-4"></div>
      <div class="step-dot" id="sd-5"></div>
    </div>

    <!-- Step 1: Phone -->
    <div class="card" id="step-phone">
      <h2>Step 1: Phone Verification</h2>
      <div class="form-group">
        <label>Mobile Phone Number</label>
        <input type="tel" id="phone" value="+1 (555) 867-5309" />
      </div>
      <button class="btn-primary" onclick="submitPhone()">Send Verification Code</button>
      <div id="phone-code" style="display:none; margin-top:16px;">
        <div class="form-group">
          <label>Enter 6-digit code</label>
          <input type="text" id="code" maxlength="6" placeholder="______" />
        </div>
        <button class="btn-primary" onclick="verifyCode()">Verify Code</button>
      </div>
    </div>

    <!-- Step 2: Driver's License -->
    <div class="card" id="step-license" style="display:none;">
      <h2>Step 2: Driver's License</h2>
      <div class="upload-zone" id="license-zone" onclick="uploadLicense()">
        <div class="upload-icon">&#128179;</div>
        <div>Click to scan or upload driver's license</div>
        <div style="font-size:0.8rem; color:#667; margin-top:4px;">Front side only</div>
      </div>
      <button class="btn-primary" id="license-btn" onclick="confirmLicense()" disabled>Continue</button>
    </div>

    <!-- Step 3: Selfie -->
    <div class="card" id="step-selfie" style="display:none;">
      <h2>Step 3: Selfie Verification</h2>
      <div class="upload-zone" id="selfie-zone" onclick="takeSelfie()">
        <div class="upload-icon">&#128247;</div>
        <div>Click to take a selfie</div>
        <div style="font-size:0.8rem; color:#667; margin-top:4px;">Match against driver's license photo</div>
      </div>
      <button class="btn-primary" id="selfie-btn" onclick="confirmSelfie()" disabled>Continue</button>
    </div>

    <!-- Step 4: Processing -->
    <div class="card" id="step-processing" style="display:none;">
      <h2>Step 4: Verifying Identity</h2>
      <div style="text-align:center; padding:24px;">
        <div class="spinner" style="width:40px;height:40px;border-width:4px;"></div>
        <div style="margin-top:16px; color:#8899aa;" id="processing-status">Cross-referencing identity documents...</div>
      </div>
    </div>

    <!-- Step 5: Complete -->
    <div class="card" id="step-complete" style="display:none;">
      <h2>Step 5: Identity Verified</h2>
      <div class="success-check">&#10003;</div>
      <div style="text-align:center; margin-bottom:16px;">
        <div style="font-size:1.1rem; font-weight:600;">Jane Doe</div>
        <div style="color:#8899aa;">Identity confirmed via IAL2 proofing</div>
      </div>
      <div id="auto-steps" style="color:#8899aa; font-size:0.85rem; text-align:center;">
        <div id="auto-status"><span class="spinner"></span> Authenticating to Broker...</div>
      </div>
    </div>
  </div>

  <!-- Knowledge Base -->
  <div id="knowledge-section">
    <div class="card">
      <h2>Client Knowledge Base</h2>
      <div class="status-section">
        <h3>Identity</h3>
        <div class="status-item"><span>Name</span><span id="kb-name">—</span></div>
        <div class="status-item"><span>Verification</span><span class="tag tag-green" id="kb-verification">—</span></div>
      </div>
      <div class="status-section">
        <h3>Authorization</h3>
        <div class="status-item"><span>Patient Context</span><span id="kb-patient">—</span></div>
        <div class="status-item"><span>Token</span><span class="tag tag-blue" id="kb-token">—</span></div>
      </div>
      <div class="status-section">
        <h3>Subscriptions</h3>
        <div id="kb-subs">None</div>
      </div>
      <div class="status-section">
        <h3>Received Encounters</h3>
        <div id="kb-encounters">Waiting for notifications...</div>
      </div>
    </div>
  </div>
</div>

<script>
let currentStep = 1;

function updateStepDots() {
  for (let i = 1; i <= 5; i++) {
    const dot = document.getElementById("sd-" + i);
    if (i < currentStep) dot.className = "step-dot done";
    else if (i === currentStep) dot.className = "step-dot active";
    else dot.className = "step-dot";
  }
}
updateStepDots();

function submitPhone() {
  const btn = event.target;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Sending...';
  setTimeout(() => {
    document.getElementById("phone-code").style.display = "";
    document.getElementById("code").value = "482916";
    btn.style.display = "none";
    // Notify server
    fetch("/id-proofing/step", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({step: "phone-sent", phone: document.getElementById("phone").value})
    });
  }, 800);
}

function verifyCode() {
  const btn = event.target;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Verifying...';
  fetch("/id-proofing/step", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({step: "phone-verified"})
  }).then(() => {
    currentStep = 2;
    updateStepDots();
    document.getElementById("step-phone").style.display = "none";
    document.getElementById("step-license").style.display = "";
  });
}

function uploadLicense() {
  const zone = document.getElementById("license-zone");
  zone.innerHTML = '<span class="spinner"></span> Scanning license...';
  fetch("/id-proofing/step", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({step: "license-scanning"})
  });
  setTimeout(() => {
    zone.className = "upload-zone uploaded";
    zone.innerHTML = '<div class="upload-icon">&#10003;</div><div>License captured</div><div style="font-size:0.8rem; margin-top:4px;">Jane Doe — DL# D1234567</div>';
    document.getElementById("license-btn").disabled = false;
    fetch("/id-proofing/step", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({step: "license-captured"})
    });
  }, 1500);
}

function confirmLicense() {
  currentStep = 3;
  updateStepDots();
  document.getElementById("step-license").style.display = "none";
  document.getElementById("step-selfie").style.display = "";
}

function takeSelfie() {
  const zone = document.getElementById("selfie-zone");
  zone.innerHTML = '<span class="spinner"></span> Capturing...';
  fetch("/id-proofing/step", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({step: "selfie-capturing"})
  });
  setTimeout(() => {
    zone.className = "upload-zone uploaded";
    zone.innerHTML = '<div class="upload-icon">&#10003;</div><div>Selfie captured</div><div style="font-size:0.8rem; margin-top:4px;">Face match: 98.7% confidence</div>';
    document.getElementById("selfie-btn").disabled = false;
    fetch("/id-proofing/step", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({step: "selfie-captured"})
    });
  }, 1200);
}

function confirmSelfie() {
  currentStep = 4;
  updateStepDots();
  document.getElementById("step-selfie").style.display = "none";
  document.getElementById("step-processing").style.display = "";
  fetch("/id-proofing/step", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({step: "verifying"})
  });
  setTimeout(() => {
    document.getElementById("processing-status").textContent = "Matching biometrics...";
    setTimeout(() => {
      document.getElementById("processing-status").textContent = "Identity confirmed!";
      currentStep = 5;
      updateStepDots();
      document.getElementById("step-processing").style.display = "none";
      document.getElementById("step-complete").style.display = "";
      // Trigger auto auth + subscribe
      fetch("/id-proofing/complete", { method: "POST" });
      // Poll for completion
      pollAutoSteps();
    }, 1500);
  }, 1200);
}

function pollAutoSteps() {
  const poll = setInterval(async () => {
    const resp = await fetch("/state");
    const s = await resp.json();
    if (s.token) {
      document.getElementById("auto-status").innerHTML = s.subscriptions?.length
        ? '&#10003; Authenticated &amp; subscribed — monitoring active'
        : '<span class="spinner"></span> Subscribing to encounter notifications...';
    }
    if (s.subscriptions?.length) {
      clearInterval(poll);
      document.getElementById("auto-status").innerHTML = '&#10003; Authenticated &amp; subscribed — monitoring active';
      document.getElementById("wizard").style.display = "none";
      showKnowledgeBase(s);
    }
  }, 500);
}

function showKnowledgeBase(s) {
  document.getElementById("knowledge-section").style.display = "";
  document.getElementById("kb-name").textContent = s.identity?.name || "Jane Doe";
  document.getElementById("kb-verification").textContent = "IAL2 Verified";
  document.getElementById("kb-patient").textContent = s.token?.patient || "—";
  document.getElementById("kb-token").textContent = s.token ? "Active" : "None";
  document.getElementById("kb-subs").innerHTML = s.subscriptions.map(sub =>
    '<div style="font-size:0.85rem; padding:4px 0;">' + sub.id + ' <span class="tag tag-green">active</span></div>'
  ).join("") || "None";
  updateEncounters(s);
  // Start SSE for live updates
  const es = new EventSource("/events");
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === "encounter-fetched" && data.resource) {
        addEncounterCard(data.resource);
      }
    } catch {}
  };
}

function updateEncounters(s) {
  if (s.encounters?.length) {
    document.getElementById("kb-encounters").innerHTML = "";
    s.encounters.forEach(enc => addEncounterCard(enc));
  }
}

function addEncounterCard(enc) {
  const el = document.getElementById("kb-encounters");
  if (el.textContent === "Waiting for notifications...") el.innerHTML = "";
  const card = document.createElement("div");
  card.className = "encounter-card";
  card.innerHTML =
    '<div class="enc-title">' + (enc.type?.[0]?.coding?.[0]?.display || "Encounter") + '</div>' +
    '<div class="enc-detail">' + (enc.serviceProvider?.display || "") + ' — ' + (enc.status || "") + '</div>' +
    '<div class="enc-detail">Patient: ' + (enc.subject?.reference || "") + '</div>' +
    '<details><summary>Full resource</summary><pre>' + JSON.stringify(enc, null, 2) + '</pre></details>';
  el.prepend(card);
}
</script>
</body>
</html>`;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;

    // Serve UI
    if (url.pathname === "/" && method === "GET") {
      return new Response(uiHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // State endpoint
    if (url.pathname === "/state" && method === "GET") {
      return Response.json(state);
    }

    // SSE stream
    if (url.pathname === "/events" && method === "GET") {
      const stream = new ReadableStream({
        start(controller) {
          sseClients.add(controller);
          // Send current state as first event
          const stateMsg = `data: ${JSON.stringify({ type: "state-sync", state })}\n\n`;
          controller.enqueue(new TextEncoder().encode(": connected\n\n" + stateMsg));
        },
        cancel(controller) {
          sseClients.delete(controller);
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // ID proofing steps — receives updates from the client UI
    if (url.pathname === "/id-proofing/step" && method === "POST") {
      const body = await req.json() as any;
      const stepNames: Record<string, string> = {
        "phone-sent": "Phone verification code sent",
        "phone-verified": "Phone number verified",
        "license-scanning": "Scanning driver's license...",
        "license-captured": "Driver's license captured — Jane Doe, DL# D1234567",
        "selfie-capturing": "Capturing selfie...",
        "selfie-captured": "Selfie captured — face match 98.7%",
        "verifying": "Cross-referencing identity documents...",
      };
      pushEvent({
        type: "id-proofing",
        detail: stepNames[body.step] || body.step,
        step: body.step,
      });
      return Response.json({ ok: true });
    }

    // ID proofing complete — auto authenticate + subscribe
    if (url.pathname === "/id-proofing/complete" && method === "POST") {
      state.identity = { verified: true, name: "Jane Doe", phone: "+1 (555) 867-5309", steps: ["phone", "license", "selfie"] };
      pushEvent({
        type: "identity-verified",
        detail: "Identity verified via IAL2 proofing — Jane Doe",
      });

      // Auto-authenticate to broker
      try {
        const tokenResp = await fetch(`${BROKER}/auth/token`, { method: "POST" });
        const tokenData = await tokenResp.json() as any;
        state.token = { access_token: tokenData.access_token, patient: tokenData.patient };
        pushEvent({
          type: "authenticated",
          detail: `Authenticated to Broker — patient context: ${tokenData.patient}`,
          response: tokenData,
        });

        // Auto-subscribe
        const subResp = await fetch(`${BROKER}/fhir/Subscription`, {
          method: "POST",
          headers: {
            "Content-Type": "application/fhir+json",
            Authorization: `Bearer ${tokenData.access_token}`,
          },
          body: JSON.stringify({
            resourceType: "Subscription",
            criteria: "Encounter?patient=Patient/" + tokenData.patient,
            channel: {
              type: "rest-hook",
              endpoint: `http://localhost:${PORT}/notifications`,
              payload: "application/fhir+json",
            },
          }),
        });
        const sub = await subResp.json() as any;
        state.subscriptions.push(sub);
        pushEvent({
          type: "subscribed",
          detail: `Subscription ${sub.id} created — monitoring encounters for ${tokenData.patient}`,
          resource: sub,
        });
      } catch (e: any) {
        pushEvent({ type: "error", detail: `Auto-setup failed: ${e.message}` });
      }

      return Response.json({ ok: true });
    }

    // Quick auth (for dashboard instant mode)
    if (url.pathname === "/quick-auth" && method === "POST") {
      state.identity = { verified: true, name: "Jane Doe", phone: "+1 (555) 867-5309", steps: ["auto"] };
      pushEvent({ type: "identity-verified", detail: "Identity verified (quick mode)" });

      try {
        const tokenResp = await fetch(`${BROKER}/auth/token`, { method: "POST" });
        const tokenData = await tokenResp.json() as any;
        state.token = { access_token: tokenData.access_token, patient: tokenData.patient };
        pushEvent({
          type: "authenticated",
          detail: `Authenticated to Broker — patient: ${tokenData.patient}`,
          response: tokenData,
        });

        const subResp = await fetch(`${BROKER}/fhir/Subscription`, {
          method: "POST",
          headers: { "Content-Type": "application/fhir+json", Authorization: `Bearer ${tokenData.access_token}` },
          body: JSON.stringify({
            resourceType: "Subscription",
            criteria: "Encounter?patient=Patient/" + tokenData.patient,
            channel: { type: "rest-hook", endpoint: `http://localhost:${PORT}/notifications`, payload: "application/fhir+json" },
          }),
        });
        const sub = await subResp.json() as any;
        state.subscriptions.push(sub);
        pushEvent({
          type: "subscribed",
          detail: `Subscription ${sub.id} created — monitoring encounters for ${tokenData.patient}`,
          resource: sub,
        });
      } catch (e: any) {
        pushEvent({ type: "error", detail: `Quick auth failed: ${e.message}` });
      }

      return Response.json(state);
    }

    // Webhook — Broker delivers notification bundles here
    if (url.pathname === "/notifications" && method === "POST") {
      const bundle = await req.json() as any;
      const dataSourceBase = bundle._dataSourceBase || "http://localhost:3003";

      state.notifications.push({ receivedAt: Date.now(), bundle });
      pushEvent({
        type: "notification-received",
        detail: "Notification bundle received from Broker",
        resource: bundle,
      });

      // Extract focus references from the notification
      const statusEntry = bundle.entry?.[0]?.resource;
      const events = statusEntry?.notificationEvent || [];

      for (const evt of events) {
        const focusRef = evt.focus?.reference;
        if (!focusRef) continue;

        pushEvent({
          type: "fetching-encounter",
          detail: `Fetching ${focusRef} from Data Source...`,
        });

        try {
          // Authenticate to data source
          const tokenResp = await fetch(`${dataSourceBase}/auth/token`, { method: "POST" });
          const tokenData = await tokenResp.json() as any;

          // Fetch the encounter
          const encResp = await fetch(`${dataSourceBase}/fhir/${focusRef}`, {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
          });
          const encounter = await encResp.json() as any;

          state.encounters.push(encounter);
          pushEvent({
            type: "encounter-fetched",
            detail: `Retrieved ${focusRef} — ${encounter.type?.[0]?.coding?.[0]?.display || "Encounter"} at ${encounter.serviceProvider?.display || "Unknown"}`,
            resource: encounter,
          });
        } catch (e: any) {
          pushEvent({ type: "fetch-error", detail: `Failed to fetch ${focusRef}: ${e.message}` });
        }
      }

      return Response.json({ ok: true });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
});

console.log(`[Client] IAS App running on :${PORT}`);
