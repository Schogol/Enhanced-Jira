// ==UserScript==
// @name        Jira Triage Assistant
// @version     2.36.0
// @author      ISD BH Schogol, ISD Tulwar
// @description Adds a Translate, Assign to GM, Convert to Defect and Close button to Jira, parses Log Files submitted from the EVE client, suggests similar existing defects on bug reports, and (on a defect) lists the open bug reports that best match it
// @updateURL   https://github.com/Schogol/Jira-Triage-Assistant/raw/main/JiTA.user.js
// @downloadURL https://github.com/Schogol/Jira-Triage-Assistant/raw/main/JiTA.user.js
// @match       https://fenriscreations.atlassian.net/jira*
// @match       https://fenriscreations.atlassian.net/browse*
// @match       https://fenriscreations.atlassian.net/issues*
// @match       https://*.cdn.prod.atlassian-dev.net/*
// @require     https://ajax.googleapis.com/ajax/libs/jquery/3.7.1/jquery.min.js#sha256=/JqT3SQfawRcv/BIHPThkBvs0OEvtFFmqPF/lYI/Cxo=
// @grant       GM_addStyle
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       GM_registerMenuCommand
// @grant       GM_unregisterMenuCommand
// @grant       GM_addValueChangeListener
// @grant       GM_xmlhttpRequest
// @connect     huggingface.co
// @connect     cdn.jsdelivr.net
// @connect     atlassian.net
// @connect     atlassian.com
// @connect     translate.googleapis.com
// ==/UserScript==
/* global $ */


// waitForKeyElements(): utility that polls the (AJAXed) DOM for elements matching a jQuery selector and runs a
// callback once per new element (marked via jQuery .data('alreadyFound') so each node fires only once). Vendored
// INLINE (verbatim, by Brock Adams - gist BrockA/2625891) instead of the old `@require .../waitForKeyElements.js`:
// that gist used GitHub's deprecated raw-URL scheme and was unpinned, so it was a fragile, mutable third-party
// dependency that gated this script's ENTIRE init. Inlining it makes the script self-contained. Requires jQuery.
function waitForKeyElements(selectorTxt, actionFunction, bWaitOnce, iframeSelector) {
    var targetNodes, btargetsFound;

    if (typeof iframeSelector == "undefined")
        targetNodes = $(selectorTxt);
    else
        targetNodes = $(iframeSelector).contents().find(selectorTxt);

    if (targetNodes && targetNodes.length > 0) {
        btargetsFound = true;
        // Found target node(s). Go through each and act if they are new.
        targetNodes.each(function () {
            var jThis = $(this);
            var alreadyFound = jThis.data('alreadyFound') || false;

            if (!alreadyFound) {
                var cancelFound = actionFunction(jThis);
                if (cancelFound)
                    btargetsFound = false;
                else
                    jThis.data('alreadyFound', true);
            }
        });
    }
    else {
        btargetsFound = false;
    }

    // Get the timer-control variable for this selector.
    var controlObj = waitForKeyElements.controlObj || {};
    var controlKey = selectorTxt.replace(/[^\w]/g, "_");
    var timeControl = controlObj[controlKey];

    // Now set or clear the timer as appropriate.
    if (btargetsFound && bWaitOnce && timeControl) {
        // The only condition where we need to clear the timer.
        clearInterval(timeControl);
        delete controlObj[controlKey];
    }
    else {
        // Set a timer, if needed.
        if (!timeControl) {
            timeControl = setInterval(function () {
                waitForKeyElements(selectorTxt, actionFunction, bWaitOnce, iframeSelector);
            }, 300);
            controlObj[controlKey] = timeControl;
        }
    }
    waitForKeyElements.controlObj = controlObj;
}


// Shared globals for the log-file parser flow: the detection / click handlers and the deferred Parse* pass run
// on separate ticks (setTimeout), so these carry state across that gap. `rows` = the raw file text;
// `oc`/`lc`/`pdm`/`dx` = which igbr.zip attachment was opened. (pdmdata / today / driverAge are now locals - the
// driver age is written straight into #driverAge by renderRequirements; menu_settings was an unused handle.)
var rows, oc, lc, pdm, dx;

// The EVE client log header row. Used both to DETECT a logs.txt (its content has this line) and to LOCATE the
// right CodeMirror editor to swap. Kept in ONE place so if CCP ever changes the header, it's a one-line edit
// instead of a hunt across every selector. NB: the parsers still index columns positionally (Type=[2],
// Message=[3], etc.), so a column *rename/reorder* would still need parser changes - this only centralizes the
// detection string.
var LOG_HDR = "Time\tFacility\tType\tMessage";


// True when this script instance is running INSIDE the Zendesk Support Forge panel's cross-origin iframe
// (host *.atlassian-dev.net) rather than the main Jira page. In that frame we ONLY run the canned-response
// dropdown injector and skip every other feature (buttons / log parser / Triage Assistant / sync), since
// none of their DOM or same-origin Jira REST calls apply there. The canned-response repository lives in GM
// storage, which Tampermonkey shares across frames, so the settings menu (main frame) edits it and the
// dropdown (this frame) reads it.
var JITA_IS_FORGE_FRAME = (function () {
    try { return /(^|\.)atlassian-dev\.net$/i.test(location.hostname); } catch (e) { return false; }
})();


// Safe GM storage wrappers. Return `dflt` when the API isn't granted (some frames / managers) or on any
// error, so callers don't repeat the `try { if (typeof GM_getValue === 'function') {…} } catch {}` guard.
// gmSet is a no-op when unavailable.
function gmGet(key, dflt) {
    try { if (typeof GM_getValue === 'function') { return GM_getValue(key, dflt); } } catch (e) { /* ignore */ }
    return dflt;
}
function gmSet(key, val) {
    try { if (typeof GM_setValue === 'function') { GM_setValue(key, val); } } catch (e) { /* ignore */ }
}


// Array which contains the locally saved values for a couple of variables.
// NOTE: index 3 ("dropdowns") is a RETIRED feature (Linked Issue Dropdowns, removed because Jira's markup
// changed and it stopped working). The slot is kept as a placeholder so the later indices (4 = buttons,
// 5 = similarDefects), which are referenced by number throughout this file, don't shift.
var savedVariables = [["key",""], ["parser", ""], ["scrollbar", ""], ["dropdowns_retired", ""], ["buttons", ""], ["similarDefects", ""]];


// Custom-scrollbar CSS, injected on load (when enabled) and by the scrollbar change-listener below. The
// removal path matches on the leading "*::-webkit-scrollbar { width: 11px…}" rule, so keep that first rule
// verbatim (and the rules run together, no separators, exactly as the old inline strings did).
var SCROLLBAR_CSS =
    '*::-webkit-scrollbar { width: 11px !important; height: 11px !important;}' +
    '*::-webkit-scrollbar-thumb { border-radius: 10px !important; background: linear-gradient(left, #96A6BF, #63738C) !important;box-shadow: inset 0 0 1px 1px #828f9e !important;}' +
    '.notion-scroller.horizontal { margin-bottom: 30px !important;}' +
    '.notion-scroller.vertical { margin-bottom: 0px !important;}';


// Listener which triggers when the locally saved "scrollbar" value is changed. If the new value is false we remove the custom scrollbar. If the new value is true we add the custom scrollbar.
GM_addValueChangeListener("scrollbar", function(key, oldValue, newValue, remote) {
    if (!newValue) {
        $('style:contains("*::-webkit-scrollbar { width: 11px !important; height: 11px !important;}")').remove();
    } else {
        GM_addStyle(SCROLLBAR_CSS);
    }
});


// Listener which triggers when the locally saved "buttons" value is changed. If the new value is false we remove the custom buttons. If the new value is true we add the custom buttons.
GM_addValueChangeListener("buttons", function(key, oldValue, newValue, remote) {
    if (!newValue) {
        $('#translateButton').remove();
        $('#GMButton').remove();
        $('#convertToDefectButton').remove();
        $('#closeButton').remove();
    } else {
        addButtons();
    }
});


// Iterate through all variables in savedVariables and load their locally saved values or set them to true if they are not set yet
for (let i = 0; i < savedVariables.length; i++) {
    savedVariables[i][1] = GM_getValue (savedVariables[i][0], "");
    if (savedVariables[i][1] === "") {
        // Every feature now defaults ON for a fresh install (the Triage Assistant graduated from its opt-in
        // Beta - see the one-time enable below for existing installs that still have it stored as false).
        GM_setValue (savedVariables[i][0], true);
        savedVariables[i][1] = GM_getValue (savedVariables[i][0], "");
    }
}


// One-time: the Triage Assistant (index 5) shipped as an opt-in Beta defaulting OFF, so existing installs
// have it persisted as false. It's now a default-on feature, so flip it ON exactly once - guarded by a flag
// so that a LATER manual toggle-off still sticks (we don't re-enable on every load).
if (typeof GM_getValue === 'function' && typeof GM_setValue === 'function') {
    if (!GM_getValue('sdDefaultOn_v1', false)) {
        GM_setValue(savedVariables[5][0], true);
        savedVariables[5][1] = true;
        GM_setValue('sdDefaultOn_v1', true);
    }
}


// Activate a custom scrollbar if the scrollbar value is set to true
if (savedVariables[2][1]) {
    GM_addStyle(SCROLLBAR_CSS);
};


// Single Tampermonkey menu entry. All feature toggles and Triage Assistant actions (sync / rebuild /
// embedding backend) live in an in-page settings overlay (JiTA.menu) instead of a long flat list of GM
// menu commands. The callback references JiTA lazily, so it's fine that the namespace is defined later.
if (!JITA_IS_FORGE_FRAME) {
    GM_registerMenuCommand("⚙ Jira Triage Assistant - Settings…", function () {
        if (typeof JiTA !== 'undefined' && JiTA.menu) { JiTA.menu.open(); }
    });
}


// Switch the embedding backend between GPU (WebGPU - fast but has been unstable on some GPUs/drivers) and
// CPU (WASM - slow but rock-solid). The choice is persisted in GM flags that JiTA.embed.load() reads:
// `sdTryWebgpu` opts into WebGPU, and `sdForceCpu` is the sticky lock the embed pass sets after a GPU device
// loss. Switching to GPU clears that lock so WebGPU is actually retried. We reload afterwards so the pipeline
// rebuilds cleanly on the chosen backend - embedding is resumable, so a reload never loses progress, and any
// already-stored vectors stay valid (same model/version; q8 vs fp32 is just minor quantization noise).
function toggleEmbedBackend() {
    var gpuOn = gmGet('sdTryWebgpu', true) && !gmGet('sdForceCpu', false);
    if (gpuOn) {
        GM_setValue('sdTryWebgpu', false);   // back to CPU/WASM
        GM_setValue('sdForceCpu', false);
    } else {
        GM_setValue('sdTryWebgpu', true);    // attempt WebGPU again
        GM_setValue('sdForceCpu', false);    // clear the sticky "GPU unstable" lock so it is actually tried
    }
    window.location.reload(false);
}


// The toggle functions call this after flipping a setting. The menu is now a single in-page overlay, so
// there's nothing to re-register with GM_registerMenuCommand - we just re-render the overlay (if it's open)
// so its switches / sections reflect the new state immediately.
function refreshMenu() {
    if (typeof JiTA !== 'undefined' && JiTA.menu && JiTA.menu.isOpen()) { JiTA.menu.render(); }
}


// Flip savedVariables[i] between true/false, persist it, and re-render the settings overlay (if open) so its
// switch reflects the new state. Shared core of every feature toggle: the in-page settings menu wires each
// switch to toggleFeature(index) via JiTA.menu._toggleRow, and a feature that needs extra work on change
// (e.g. the Triage Assistant tearing down / re-mounting its panel) passes an onAfter callback there.
function toggleFeature(i) {
    savedVariables[i][1] = !savedVariables[i][1];
    GM_setValue(savedVariables[i][0], savedVariables[i][1]);
    refreshMenu();
};


// waitForKeyElements waits until the it finds the "Give Feedback" element of the page and then removes it because we dont want that to take up space.
var feedbackItem = 'button[data-testid="issue-navigator.common.ui.feedback.feedback-button"]';
waitForKeyElements (feedbackItem, removeFeedbackButton);


// Remove the Feedback element
function removeFeedbackButton() {
    $('button[data-testid="issue-navigator.common.ui.feedback.feedback-button"]').parent().remove()
};


// waitForKeyElements waits until the page is loaded and then runs the checkIssueType function.
var issueItem = 'a[data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]';
waitForKeyElements (issueItem, checkIssueType);

// The current issue's key (e.g. "EBR-67728"), read from the breadcrumb. Returns '' when not on an issue.
function jitaCurrentKey() { return $.trim($(issueItem).text()); }


// Check if the issue is a Bug report. If it is then we add the extra buttons
function checkIssueType() {
    if ($(issueItem + ':contains("EBR")').length > 0 && savedVariables[4][1]) {
        addButtons();
    }
};


// Re-adds our buttons whenever they go missing. Atlassian renders the issue action bar with React and,
// once the issue data finishes loading, re-renders it ~2s after the initial paint (confirmed: a single
// re-render that swaps the whole quick-add toolbar for fresh nodes; it also happens again when navigating
// between issues in the SPA). That re-render throws away the buttons we injected as siblings of the
// quick-add trigger, and because waitForKeyElements only fires its callback once per element it never puts
// them back. So instead we watch the DOM and re-inject whenever they disappear. addButtons() already guards
// each button with an "if length === 0" check, so calling it repeatedly only fills in what's missing and
// never duplicates.
// We observe document.body rather than the toolbar container on purpose: the trigger's parent is an
// anonymous <div> with no id/class/data-testid, so there is no stable selector to scope a narrower observer
// to. The guard below early-exits in microseconds, so watching broadly is cheap.
function ensureButtonsPresent() {
    if (!savedVariables[4][1]) { return; }                                    // user toggled the buttons off
    if ($('#translateButton').length) { return; }                            // already present, nothing to do
    if (!$(issueItem + ':contains("EBR")').length) { return; } // not a bug report
    if (!$('button[data-testid="issue-view-foundation.quick-add.quick-add-items-compact.apps-button-dropdown--trigger"]').length) { return; } // action bar not ready yet
    addButtons();
}

// Throttle: a single issue-view re-render fires a burst of mutations, so we coalesce them and run the
// (cheap, early-exiting) check at most once every 200ms rather than on every individual mutation.
var jitaButtonGuardScheduled = false;
var jitaButtonObserver = new MutationObserver(function () {
    if (jitaButtonGuardScheduled) { return; }
    jitaButtonGuardScheduled = true;
    setTimeout(function () {
        jitaButtonGuardScheduled = false;
        ensureButtonsPresent();
        try { jitaShowIssueDates(); } catch (e) { /* ignore */ }   // mirror Created/Updated into the top header
        try { jitaHideNativeDates(); } catch (e) { /* ignore */ }   // ...and hide Jira's native bottom timestamps
    }, 200);
});
if (!JITA_IS_FORGE_FRAME) { jitaButtonObserver.observe(document.body, { childList: true, subtree: true }); }


// ---- Surface the issue's Created / Updated dates at the TOP of the header ----
// Jira only renders Created/Updated ("N ago") at the very BOTTOM of the right context column, so you have to
// scroll to see them. Mirror them into the top header bar (the empty space between the breadcrumb and the
// lock / watch / share / … action icons) so they're visible at a glance. Same-origin REST read, cached per
// issue. Always on for issue pages; cheap early-exit once mounted for the current issue.
var jitaDatesCache = {};   // issueKey -> { created, updated } ISO strings
function jitaFmtDateShort(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) { return ''; }
    var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getDate()) + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear();
}

// Find where to drop the dates element. The lock / watch / share / … icons live in the sticky header bar
// #jira-issue-header-actions, which spans the full width of the issue's right-most context column but only
// contains the (right-aligned) action-icon group - so the whole empty left part of that bar is the "red box".
// We anchor to that bar and absolutely-position the dates at its LEFT edge (the bar is position:sticky, i.e. a
// positioning context, so left:0 lands on the red-box border and top:50% keeps it level with the icons). The
// breadcrumb is in a SEPARATE left structure, so it can't be used as a row anchor. Fallbacks probe the sticky-
// header testid, then derive the bar from the watch button.
function jitaDatesTarget() {
    var bar = document.getElementById('jira-issue-header-actions')
        || document.querySelector('[data-testid="issue-view-sticky-header-container.sticky-header"]');
    if (!bar) {
        var watch = document.querySelector('button[data-testid="issue.watchers.action-button.root"]')
            || document.querySelector('button[data-testid*="watch" i]')
            || document.querySelector('button[aria-label*="watch" i]');
        bar = (watch && watch.closest)
            ? (watch.closest('#jira-issue-header-actions') || watch.closest('[data-testid="issue-view-sticky-header-container.sticky-header"]'))
            : null;
    }
    if (!bar) { return null; }
    return { row: bar, before: null };   // before:null -> append; the element is absolutely positioned at left:0
}

function jitaShowIssueDates() {
    var bc = document.querySelector(issueItem);
    if (!bc) {   // not on an issue page -> drop any stale element
        var gone = document.getElementById('jita-issue-dates');
        if (gone && gone.parentNode) { gone.parentNode.removeChild(gone); }
        return;
    }
    var key = (bc.textContent || '').trim();
    if (!key) { return; }
    var existing = document.getElementById('jita-issue-dates');
    if (existing && existing.getAttribute('data-key') === key && existing.isConnected) { return; }   // already shown for this issue
    var tgt = jitaDatesTarget();
    if (!tgt) { return; }   // header not ready yet; the observer will retry
    if (existing && existing.parentNode) { existing.parentNode.removeChild(existing); }

    var el = document.createElement('div');
    el.id = 'jita-issue-dates';
    el.setAttribute('data-key', key);
    // Absolutely positioned near the LEFT edge of the sticky header bar (its positioning context), vertically
    // centered with the icons. A small left inset (not 0) clears the bar's left clip/overflow so the first
    // characters aren't cut off. Two stacked rows; each row is a flex with the LABEL left and the DATE pushed
    // to the right (margin-left:auto), and the rows stretch to the same width so the dates line up right-bound.
    el.style.cssText = 'position:absolute; left:24px; top:50%; transform:translateY(-50%);' +
        ' display:flex; flex-direction:column; gap:1px;' +
        ' font-size:12px; line-height:1.35; color:var(--ds-text-subtle,#8c9bab); white-space:nowrap; user-select:none;';
    el.textContent = '…';
    tgt.row.insertBefore(el, tgt.before);   // before:null -> append

    function paint(created, updated) {
        if (el.getAttribute('data-key') !== key || !el.isConnected) { return; }   // navigated away meanwhile
        el.textContent = '';
        function part(label, iso) {
            if (!iso) { return; }
            var row = document.createElement('div');
            row.style.cssText = 'display:flex; gap:18px;';
            try { row.title = label + ': ' + new Date(iso).toLocaleString(); } catch (e) { /* ignore */ }
            var lbl = document.createElement('span');
            lbl.textContent = label;
            var val = document.createElement('span');
            val.textContent = jitaFmtDateShort(iso);
            val.style.marginLeft = 'auto';   // push the date to the right edge of the (stretched) row
            row.appendChild(lbl);
            row.appendChild(val);
            el.appendChild(row);
        }
        part('Created', created);
        part('Updated', updated);
    }

    if (jitaDatesCache[key]) { paint(jitaDatesCache[key].created, jitaDatesCache[key].updated); return; }
    $.ajax({ url: 'https://fenriscreations.atlassian.net/rest/api/2/issue/' + key + '?fields=created,updated', dataType: 'json' })
        .done(function (d) {
            var f = (d && d.fields) || {};
            jitaDatesCache[key] = { created: f.created || null, updated: f.updated || null };
            paint(jitaDatesCache[key].created, jitaDatesCache[key].updated);
        })
        .fail(function () { if (el.isConnected) { el.textContent = ''; } });
}

// Jira renders the issue's Created/Updated timestamps a second time at the very BOTTOM of the right context
// column (the spot you'd otherwise have to scroll to). Now that we mirror them into the top header, hide that
// native block so the date isn't shown twice. Jira gives those rows stable testids
// ("created-date.ui.read.meta-date" / "updated-date.ui.read.meta-date"), so we target them directly. Idempotent.
function jitaHideNativeDates() {
    var nodes = document.querySelectorAll(
        '[data-testid="created-date.ui.read.meta-date"], [data-testid="updated-date.ui.read.meta-date"],' +
        ' [data-testid$="-date.ui.read.meta-date"]');
    for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n.getAttribute('data-jita-hidden-dates')) { continue; }   // already hidden
        n.style.display = 'none';
        n.setAttribute('data-jita-hidden-dates', '1');
    }
}

// Initial nudge in case the header is already present before the first DOM mutation fires.
waitForKeyElements(issueItem, function () {
    try { jitaShowIssueDates(); } catch (e) { /* ignore */ }
    try { jitaHideNativeDates(); } catch (e) { /* ignore */ }
});


// Free translation via Google's keyless "gtx" endpoint (translate_a/single). No API key, no cost - this
// replaces the old paid Cloud Translation v2 API that kept hitting the free-tier quota. We POST (rather
// than GET) so a long EVE description can't blow the URL length limit, and go through GM_xmlhttpRequest so
// CORS is a non-issue (no session cookie needed). Source language is auto-detected (sl=auto -> tl=en).
// Resolves to: the translated string, '' for empty input, or null on failure (HTTP error / throttle / parse).
function jitaTranslateFree(text) {
    return new Promise(function (resolve) {
        var t = (text || '').trim();
        if (!t) { resolve(''); return; }
        GM_xmlhttpRequest({
            method: 'POST',
            url: 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            data: 'q=' + encodeURIComponent(t),
            onload: function (resp) {
                try {
                    if (resp.status < 200 || resp.status >= 300) { resolve(null); return; }
                    // Response is a nested array: arr[0] is a list of sentence chunks, each chunk[0] is the
                    // translated text; join them. (arr[2] is the detected source language, unused.)
                    var arr = JSON.parse(resp.responseText);
                    var out = (arr && arr[0])
                        ? arr[0].map(function (c) { return (c && c[0]) ? c[0] : ''; }).join('')
                        : '';
                    resolve(out);
                } catch (e) { resolve(null); }
            },
            onerror: function () { resolve(null); },
            ontimeout: function () { resolve(null); }
        });
    });
}


// Standard $.ajax error handler for the action buttons: log the raw response, then alert `msg` (default: the
// generic failure text) followed by the shared "check console / report to Schogol" tail. Returns the handler.
function jitaAjaxError(msg) {
    return function (data) {
        console.log(JSON.stringify(data));
        alert((msg || 'This failed for some reason.') + ' Check Console for errors and report issues to Schogol :).');
    };
}

// Convert-to-Defect (EBR -> EDR) automation rule id (invoked via jitaInvokeAutomationRule).
var JITA_CONVERT_DEFECT_RULE = '767335';

// POST a manual automation-rule invocation for the issue with the given NUMERIC id (ari .../issue/<id>). Optional
// `userInputs` carries a form selection (Convert-to-Defect passes none). Returns the $.ajax promise.
function jitaInvokeAutomationRule(numericId, ruleId, userInputs) {
    var cloudId = $('meta[name="ajs-cloud-id"]').attr('content');
    var body = { objects: ['ari:cloud:jira:' + cloudId + ':issue/' + numericId] };
    if (userInputs) { body.userInputs = userInputs; }
    return $.ajax({
        url: 'https://fenriscreations.atlassian.net/gateway/api/automation/internal-api/jira/' + cloudId + '/pro/rest/v1/rules/manual/invocation/' + ruleId,
        type: 'POST', contentType: 'application/json', charset: 'utf-8',
        data: JSON.stringify(body)
    });
}

// Keys of the issues linked to a v2 issue (from its fields.issuelinks - either side of each link).
function jitaLinkedKeys(links) {
    var keys = [];
    (links || []).forEach(function (l) {
        var other = l.outwardIssue || l.inwardIssue;
        if (other && other.key) { keys.push(other.key); }
    });
    return keys;
}

// After Convert-to-Defect, the automation creates a defect and links it to the EBR. Poll the EBR's links for one
// that wasn't there before (prefer a defect project) and navigate to it. Falls back to reloading the EBR after
// ~30s if none appears (e.g. the conversion linked it some other way).
function jitaGoToNewDefect(ebrKey, beforeKeys) {
    var before = {};
    (beforeKeys || []).forEach(function (k) { before[k] = true; });
    var tries = 0;
    (function poll() {
        $.ajax({ url: 'https://fenriscreations.atlassian.net/rest/api/2/issue/' + ebrKey + '?fields=issuelinks', type: 'GET', dataType: 'json' })
            .done(function (d) {
                var fresh = jitaLinkedKeys(d.fields && d.fields.issuelinks).filter(function (k) { return !before[k]; });
                var defect = fresh.filter(function (k) { return /^(EDR|EO|PLAT)-/.test(k); })[0] || fresh[0];
                if (defect) { window.location.href = '/browse/' + defect; return; }
                if (tries >= 30) { window.location.reload(false); return; }
                tries++; setTimeout(poll, 1000);
            })
            .fail(function () {
                if (tries >= 30) { window.location.reload(false); return; }
                tries++; setTimeout(poll, 1000);
            });
    })();
}

// Adds the different buttons to the "command-bar" and defines what they do
function addButtons() {
    // The native quick-add trigger: we copy its (react-churned) classes to style our buttons like it, and
    // insert ours right after it.
    var TRIGGER_SEL = 'button[data-testid="issue-view-foundation.quick-add.quick-add-items-compact.apps-button-dropdown--trigger"]';
    let buttonClass = $(TRIGGER_SEL).attr('class');
    let innerSpanClass = $(TRIGGER_SEL).find('span').eq(0).attr('class');

    // Build one command-bar button (styled to match the trigger) and insert it after the trigger, unless it's
    // already present. A native <button> is keyboard-focusable in natural DOM order and takes its accessible
    // name from the visible label, so no tabindex / aria-label is needed. Click handlers are wired below.
    function addActionButton(id, label) {
        if ($('#' + id).length) { return; }
        var $btn = $(
            '<button id="' + id + '" type="button" class="' + buttonClass + '" ' +
            'style="margin-left: 8px; width: fit-content; padding: 6px 8px 6px 3px; white-space: nowrap; display: inline-flex; align-items: center;">' +
            '<span class="' + innerSpanClass + '"></span>' +
            '<span style="font-size: 13px;">' + label + '</span>' +
            '</button>'
        );
        $(TRIGGER_SEL).after($btn);
    }

    // Create Translate Button
    addActionButton('translateButton', 'Translate');

    // When the translate button is clicked we translate the Issue title + description blocks to English via
    // Google's FREE keyless gtx endpoint (jitaTranslateFree). One request per text, run in parallel, then we
    // replace the original Title / Description / Repro-Steps with the translation - same DOM mapping as before.
    $("#translateButton").off('click.jita').on('click.jita', function () {
        var $title = $("h1[data-testid='issue.views.issue-base.foundation.summary.heading']");
        var $desc = $("div[data-component-selector='jira-issue-view-rich-text-inline-edit-view-container']");
        // Read with innerText (NOT jQuery .text()/textContent): innerText reflects the RENDERED text and
        // inserts "\n" at <br> and paragraph/block boundaries, so the line structure survives into the
        // translation. textContent would jam every paragraph together and the linebreaks would be lost
        // before Google ever sees them. (gtx itself preserves the \n it's given.) Falls back to .text().
        function readText($el) {
            var el = $el[0];
            return (el && typeof el.innerText === 'string' && el.innerText.length) ? el.innerText : $el.text();
        }
        // Write the translation INTO the existing <p> of a description block, keeping every wrapper. Jira
        // renders each block as <div style="--ak-renderer-editor-font-normal-text: ..."> > .ak-renderer-document
        // > <p>, and the body font is applied to that inner <p> via the CSS variable. So we keep the <p>
        // (and its .ak-renderer-document parent) intact and only set its text. We use .text() with the raw
        // newlines (no <br>): that same <p> already rendered the original multi-line text with its breaks
        // visible, so its white-space CSS preserves our "\n" too - and .text() auto-escapes any < / & in the
        // translation. Extra sibling paragraphs are removed since the whole block is merged into the first <p>.
        function setBlockText($block, txt) {
            if (!$block || !$block.length) { return; }
            var $p = $block.find('p').first();
            if ($p.length) {
                $p.nextAll().remove();   // drop any following paragraphs - everything now lives in the first <p>
                $p.text(txt);
            } else {
                $block.text(txt);        // no <p> found (unusual structure) - fall back to the block's text
            }
        }
        var titleText = readText($title);
        var d0 = readText($desc.children().eq(0));
        var d1 = readText($desc.children().eq(1));
        Promise.all([jitaTranslateFree(titleText), jitaTranslateFree(d0), jitaTranslateFree(d1)])
            .then(function (tr) {
                // null == request failed (HTTP error / throttle / parse); all-null means nothing came back.
                if (tr[0] === null && tr[1] === null && tr[2] === null) {
                    alert("Cannot get translation - Google may be rate-limiting. Wait a moment and try again.\r\nReport issues to Schogol :).");
                    return;
                }
                if (tr[0]) { $title.text(tr[0]); }
                if (tr[1]) { setBlockText($desc.children().eq(0), tr[1]); }
                if (tr[2]) { setBlockText($desc.children().eq(1), tr[2]); }

                // The Triage Assistant reads its search query straight from these same DOM nodes (see
                // JiTA.ui.getIssueText), so now that they hold the ENGLISH translation, re-run the similar-
                // defects search - otherwise it keeps matching against the reporter's native-language text and
                // finds little. Guarded so this only fires when the Triage Assistant is enabled in settings
                // (savedVariables[5]) AND its panel is live on this bug report; the typeof guard also keeps the
                // Translate button working when the Similar Defects feature's code isn't loaded at all.
                if (typeof JiTA !== 'undefined' && JiTA.ui && savedVariables[5][1]
                    && JiTA.ui.currentKey && /^EBR-/.test(JiTA.ui.currentKey)) {
                    JiTA.ui.render(JiTA.ui.currentKey);
                }
            });
    });


    // Create GM Button
    addActionButton('GMButton', 'Assign to GM');

    // When the Assign to GM button is clicked we change the Team to "EO - Game Masters" and also visually change the field so the user sees that it worked.
    // .off('click.jita').on(...) so re-running addButtons (React re-renders / SPA nav) never STACKS a second handler on the same button.
    $("#GMButton").off('click.jita').on('click.jita', function () {
        var key = jitaCurrentKey();
        $.ajax({
            url: 'https://fenriscreations.atlassian.net/rest/api/2/issue/' + key,
            type: 'PUT',
            contentType: 'application/json',
            charset: 'utf-8',
            data: '{"fields":{"customfield_10001":"38"}}',

            // When the change of the team via API is successful we change the Team visually for the user to also see that as the Issue doesnt update automatically
            success: function (data) {
                $('div[data-testid="issue-field-heading-styled-field-heading.field"]:contains(Team)').parent().children('div').eq(1).text('EO - GameMasters');
                // After changing the Team field to "EO - Game Masters" we change the Assignee field to "Unassigned" because GMs wont be able to see the BRs in their filters if they are assigned to someone.
                $.ajax({
                    url: 'https://fenriscreations.atlassian.net/rest/api/3/issue/' + key + '/assignee',
                    type: 'PUT',
                    contentType: 'application/json',
                    charset: 'utf-8',
                    data: '{"accountId":null}',

                    success: function (data) {
                        $('div[data-testid="issue-field-heading-styled-field-heading.assignee"]:contains(Assignee)').parent().children('div').eq(1).text('Unassigned');
                    },

                    // If we get an Error we annoy the user by telling them that it failed and to check their Dev Console for errors
                    error: jitaAjaxError("Wasn't able to change Assignee field to 'Unassigned'.")
                });

            },

            // If we get an Error then we annoy the user by telling them that it failed and to check their Dev Console for errors
            error: jitaAjaxError()
        });
    });


    // Create Convert To Defect Button
    addActionButton('convertToDefectButton', 'Convert to Defect');
    // When the Convert to Defect button is clicked we trigger the Automation which converts the EBR into an EDR issue
    // .off('click.jita').on(...) so re-running addButtons (React re-renders / SPA nav) never STACKS a second handler
    // on the same button - stacked handlers fired the automation twice and created two defects.
    $("#convertToDefectButton").off('click.jita').on('click.jita', function () {
        var $btn = $(this);
        if ($btn.prop('disabled')) { return; }                 // conversion already in progress - ignore extra clicks
        $btn.prop('disabled', true);
        var ebrKey = jitaCurrentKey();
        function fail(xhr) { $btn.prop('disabled', false); jitaAjaxError()(xhr); }
        // Snapshot the EBR's numeric id + existing issue links, run the conversion automation, then navigate to the
        // newly-created defect (found as the freshly-linked issue that wasn't linked before).
        $.ajax({ url: 'https://fenriscreations.atlassian.net/rest/api/2/issue/' + ebrKey + '?fields=issuelinks', type: 'GET', dataType: 'json' })
            .done(function (d) {
                var before = jitaLinkedKeys(d.fields && d.fields.issuelinks);
                jitaInvokeAutomationRule(d.id, JITA_CONVERT_DEFECT_RULE)
                    .done(function () { jitaGoToNewDefect(ebrKey, before); })   // poll the EBR's links for the new defect, then navigate
                    .fail(fail);
            }).fail(fail);
    });


    // Create close button
    addActionButton('closeButton', 'Close');
    // When the Close button is clicked we change the status to Closed by simulating clicks on the relevant buttons. This is extremely janky right now because I cant figure out a better way to do this.
    $("#closeButton").off('click.jita').on('click.jita', function () {
        $("div[data-testid='issue.views.issue-base.foundation.status.status-field-wrapper']").find("button").click();
        setTimeout(function(){$("div[data-testid='issue.fields.status.common.ui.status-lozenge.3']").children().find("span:contains(Closed)").click();}, 100);
    });
};


// When we detect the "title row" of a log parser file then we swap out the content of the log file with a parsed, more readable version of it with some extra features like buttons which allow you to toggle the visibility of certain types of events
var selector = "span[data-testid='code-block']:contains(" + LOG_HDR + ")";
waitForKeyElements(selector, SwapUI);


// When we detect the "title row" of a processHealth file then we swap out the content of the log file with a parsed, more readable version of it with some extra features
var phSelector = "span[data-testid='code-block']:contains(dateTime	pyDateTime	procCpu	threadCpu	pyMem	virtualMem	taskletsProcessed	taskletsQueued	watchdog time	spf	serviceCalls	callsFromClient	bytesReceived	bytesSent	packetsReceived	packetsSent	sessionCount	tidiFactor)";
waitForKeyElements(phSelector, SwapUI);


// When we detect the "title row" of a methodCalls file then we swap out the content of the log file with a parsed, more readable version of it with some extra features
var McSelector = "span[data-testid='code-block']:contains(Time	Method	Duration [ms])";
waitForKeyElements(McSelector, SwapUI);


// The logs.txt attached directly to a report (as opposed to the one inside the igbr.zip) is now rendered
// by CodeMirror, which wraps every line in a <div class="cm-line"> instead of a <span data-testid="code-block">.
// CodeMirror only keeps the visible lines in the DOM, so we detect the file by its (always-present) header
// row and let SwapUI pull the full text out of CodeMirror's in-memory state. (processHealth / methodCalls
// only ever appear inside the igbr.zip, which still uses the <span> layout, so they need no CodeMirror path.)
var cmSelector = ".cm-line:contains(" + LOG_HDR + ")";
waitForKeyElements(cmSelector, SwapUI);


// outstandingcalls.txt / lastcrashes.txt / PDMData.txt live inside the igbr.zip and - unlike the log /
// processHealth / methodCalls files - have NO header row in their content to detect them by. So the only way to
// tell them apart is WHICH file button was clicked: watch for each file's entry in the attachment list, and when
// its button is clicked, poll for the freshly-loaded text (jitaRunParserWhenLoaded) and set the matching parser
// flag that SwapUI dispatches on.
// The click binding is namespaced and .off()'d first so re-firing can never stack duplicate handlers: the SPA
// re-rendering the attachment list makes waitForKeyElements match a fresh span and re-run this callback.
var IGBR_FILES = [
    { name: 'outstandingcalls.txt', setFlag: function () { oc = true; } },
    { name: 'lastcrashes.txt',      setFlag: function () { lc = true; } },
    { name: 'PDMData.txt',          setFlag: function () { pdm = true; } },
    { name: 'dxdiag.txt',           setFlag: function () { dx = true; } }
];
IGBR_FILES.forEach(function (f) {
    waitForKeyElements('span[data-item-title="true"]:contains(' + f.name + ')', function () {
        $("button:contains('" + f.name + "')")
            .off('click.jita').on('click.jita', function () { jitaRunParserWhenLoaded(f.setFlag); });
    });
});


// outstandingcalls.txt / lastcrashes.txt / PDMData.txt load their text ASYNCHRONOUSLY into the
// <span data-testid="code-block"> after the file button is clicked. The old code just waited a fixed 750ms and
// hoped the content had arrived - if the load was slower, SwapUI parsed empty/stale content and you were out
// of luck. Instead, poll for THIS file's raw text to appear in the code-block and only then set the parser flag
// + run SwapUI. A naive "content changed -> fire" poll corrupts, so it's guarded on five fronts:
//   1. Generation token - a NEWER click (incl. a double-click of the same file) supersedes an earlier poller,
//      so stale pollers can't fire.
//   2. Empty file - if the clicked file is empty its content never arrives, so we time out at MAX and give up
//      rather than polling forever.
//   3. #tableContent present - our (or another file's) parser markup is currently mounted, so the raw file text
//      isn't showing; keep waiting for the viewer to swap it back in.
//   4. HEADER_SIG - a header-based file (log / processHealth / methodCalls) loaded instead; those are handled
//      by waitForKeyElements+SwapUI, so we must not grab them as our oc/lc/pdm file.
//   5. Cancel-on-navigate (the jitaParserGen bump below) - the poller watches a SHARED code-block, so if you open
//      an EMPTY tracked file (its poller keeps waiting - no content ever arrives) and then click ANOTHER file
//      before MAX, that file's content lands in the same span and would trip the stale poller, parsing it into
//      the wrong table (the reported bug: empty outstandingcalls -> click fitting.txt -> fitting in the OC table).
//      Guards #1/#2 don't catch this: an UNtracked file (fitting.txt / prefs.ini / ...) has no click handler to
//      bump the generation, and its content arrives well before the #2 timeout. So we bump the generation on
//      EVERY file-entry click, which kills any pending poller the moment you navigate away.
// `setFlag` marks which parser branch SwapUI takes (oc / lc / pdm).
var jitaParserGen = 0;
// Guard #5: clicking any file entry in the igbr.zip viewer cancels a pending poller. Capture phase, so it runs
// BEFORE the tracked button's bubble handler - a tracked file then starts a fresh poller with the newer (winning)
// generation, while an untracked file just leaves every poller cancelled. File entries are <button>s containing a
// [data-item-title] element (the same markers waitForKeyElements uses above); other buttons (download, toggles)
// have no such child and are ignored.
document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('button') : null;
    if (btn && btn.querySelector('[data-item-title]')) { jitaParserGen++; }
}, true);
function jitaRunParserWhenLoaded(setFlag) {
    var myGen = ++jitaParserGen;
    var CB = "span[data-testid='code-block']";
    var HEADER_SIG = new RegExp(LOG_HDR + '|dateTime\tpyDateTime\tprocCpu|Time\tMethod\tDuration');
    var before = ($(CB).text() || '').trim();
    var start = Date.now(), MAX = 8000, POLL = 100;
    (function poll() {
        if (myGen !== jitaParserGen) { return; }                 // superseded by a newer click
        if (Date.now() - start > MAX) { return; }               // empty / never-loaded file -> don't parse
        var $cb = $(CB), now = ($cb.text() || '').trim();
        var ready = !document.getElementById('tableContent')    // no parser markup currently mounted
            && $cb.length && now && now !== before              // new, non-empty raw content
            && !HEADER_SIG.test(now);                           // ...and not a header-based file (not ours)
        if (ready) { setFlag(); SwapUI(); return; }
        setTimeout(poll, POLL);
    })();
}

// Reads the complete text of a file rendered by the new CodeMirror-based viewer.
// CodeMirror only keeps the lines currently in view inside the DOM, but it holds the whole document
// in its in-memory editor state. The userscript sandbox can't reach CodeMirror's internal DOM property,
// so we run the read in the page context via an injected <script> and hand the text back through a
// shared, hidden DOM node (which both contexts can see).
function getCmDocText() {
    var NODE_ID = 'JITA_cmdoc_transfer';

    var transfer = document.getElementById(NODE_ID);
    if (!transfer) {
        transfer = document.createElement('div');
        transfer.id = NODE_ID;
        transfer.style.display = 'none';
        document.documentElement.appendChild(transfer);
    }
    transfer.textContent = '';

    var pageCode =
        '(function(){var out=document.getElementById(' + JSON.stringify(NODE_ID) + ');try{' +
        'var c=document.querySelector(".cm-content[data-jita-cmsrc]")||document.querySelector(".cm-content");' +
        'var dv=c&&c.cmView;' +
        'var v=dv&&(dv.view||(dv.rootView&&dv.rootView.view)||dv.editorView);' +
        'out.textContent=(v&&v.state)?v.state.doc.toString():"";' +
        '}catch(e){out.textContent="";}})();';

    var s = document.createElement('script');
    s.textContent = pageCode;
    (document.head || document.documentElement).appendChild(s);
    if (s.parentNode) { s.parentNode.removeChild(s); }

    // The injected script runs synchronously the moment it is inserted, so the text is ready now.
    var text = transfer.textContent || '';
    transfer.textContent = '';
    return text;
}


// Shared code-block prep for the igbr.zip (<span data-testid="code-block">) parser branches: drop empty spans
// + inline comment spans, then read the raw file text into the module-level `rows`. Returns `rows`.
function readCodeBlock() {
    $('code > span:empty').remove();
    $('span[data-testid="code-block"]').find('span > span.comment').remove();
    rows = $("span[data-testid='code-block']").text();
    return rows;
}

// Prep the code-block, replace it with `viewHtml`, then kick off `parseFn` once the parser markup has mounted.
// Used by the log / processHealth / methodCalls / outstandingCalls / lastCrashes branches of SwapUI.
function mountParser(viewHtml, parseFn) {
    readCodeBlock();
    $("span[data-testid='code-block']").html(viewHtml);
    setTimeout(parseFn, 250);
}


// Swap out the UI when looking at a log file and add the buttons to toggle message types at the top of the page
function SwapUI() {
    // --- New CodeMirror-based viewer (files attached directly to the report) ---
    // Detect the file type from its (always-rendered) header row, pull the complete text straight out of
    // CodeMirror's state, drop our parser UI into the editor container, then reuse the existing parsers.
    // Files inside the igbr.zip still use the old <span> layout and are handled by the original code below.
    // Scope everything to the ONE editor that holds the log header row: the page can contain OTHER CodeMirror
    // editors (a ``` code block in the comment box is also a .cm-editor / .cm-content), and operating on all of
    // them read the wrong (comment) text into `rows` AND injected the "Logfile Parser" UI into the comment box.
    var $logEd = $(".cm-line:contains(" + LOG_HDR + ")").first().closest('.cm-editor');
    if ($logEd.length && !$("span[data-testid='code-block']").length && savedVariables[1][1]) {
        var $cm = $logEd.find('.cm-content').first().attr('data-jita-cmsrc', '1');   // mark the exact source editor
        rows = getCmDocText();                                                       // reads the marked .cm-content
        $cm.removeAttr('data-jita-cmsrc');
        $logEd.html(html);
        // The parser's scrollable #table is position:absolute (top:85px; bottom:0), so it sizes itself
        // against the nearest positioned ancestor. In the old <span> viewer that ancestor filled the screen;
        // CodeMirror's .cm-editor is position:relative but only a sliver tall, which collapses #table and
        // clips every row. Pin #table to the viewport instead (the media viewer is full-screen) so all rows
        // are visible and scrollable.
        $('#table').css({ position: 'fixed', top: '95px', bottom: '0', left: '0', width: '100%' });
        setTimeout(ParseLogs, 250);
        // NB: no early return here. The <span> checks below are no-ops on this layout (no code-block span),
        // but we must fall through to the "$('#gpanel a').click(...)" handler at the end of SwapUI so the
        // Toggle Notice / Warnings / Errors / Exceptions filter buttons get wired up.
    }

    else if ($("span[data-testid='code-block']:contains(" + LOG_HDR + ")")[0] && savedVariables[1][1]) {
        mountParser(html, ParseLogs);
    }

    else if ($("span[data-testid='code-block']:contains(dateTime	pyDateTime	procCpu	threadCpu	pyMem	virtualMem	taskletsProcessed	taskletsQueued	watchdog time	spf	serviceCalls	callsFromClient	bytesReceived	bytesSent	packetsReceived	packetsSent	sessionCount	tidiFactor)")[0] && savedVariables[1][1]) {
        mountParser(phHtml, ParsePhLogs);
    }

    else if ($("span[data-testid='code-block']:contains(Time	Method	Duration [ms])")[0] && savedVariables[1][1]) {
        mountParser(McHtml, ParseMcLogs);
    }

    else if (oc && savedVariables[1][1]) {
        oc = false;
        mountParser(ocHtml, ParseOcLogs);
    }

    else if (lc && savedVariables[1][1]) {
        lc = false;
        mountParser(lcHtml, ParseOcLogs);
    }

    else if (dx && savedVariables[1][1]) {
        readCodeBlock();
        $("span[data-testid='code-block']").append(dxdiagHtml);
        // Parse the raw dxdiag text into a triage summary (crash history + GPU driver recency + system). Guarded.
        try { renderDxdiag(rows); } catch (e) { $('#dxdiag').text('Could not evaluate dxdiag.'); }
        dx = false;
    }

    else if (pdm && savedVariables[1][1]) {
        readCodeBlock();
        $("span[data-testid='code-block']").append(pdmHtml);
        var pdmdata = convertTextToObject(rows);
        // Judge the machine against EVE's system requirements and render a per-component breakdown into the
        // Quick Info box (verdict + OS/CPU/RAM/GPU/DirectX rows + driver age). Guarded end-to-end.
        try { renderRequirements(pdmdata); } catch (e) { $('#Requirements').text('Could not evaluate system requirements.'); }
        pdm = false;
    };


    // Functionality for the buttons in the gpanel to toggle show / hide specific table rows
    $("#gpanel a").click(function() {
        switch ($(this).hasClass('toggle')) {
            case false:
                $('.'+$(this).attr('id')).css({'display':'none'});
                $(this).not($('#onlyexception, #showAll')).addClass('toggle');
                break;
            default:
                $('.'+$(this).attr('id')).css({'display':'table-row'});
                $(this).removeClass('toggle');
                break;
        };
        switch ($(this).attr('id')) {
            case "onlyexception":
                $('tr:not(.exception):not(#fixedHead)').css({'display':'none'});
                $('tr.exception').css({'display':'table-row'});
                $('#gnav a#notice, #gnav a#error, #gnav a#warning').addClass('toggle');
                $('#gnav a#exception').removeClass('toggle');
                break;
            case "showAll":
                $('tr').css({'display':'table-row'});
                $('#gnav a#notice, #gnav a#warning, #gnav a#error, #gnav a#exception').removeClass('toggle');
                break;
            default:
                break;
        }
    });

    // Live search box (Feature D): filter rows by text, composing with the type toggles above. A row is
    // shown iff it matches the (case-insensitive) query AND its message-type isn't currently toggled off.
    // jitaApplyLogFilter recomputes visibility from the toggle state (including the "Only Exceptions" combo,
    // which also hides info rows) so search and the toggle buttons never fight. Wired only on the main log
    // parser, the one layout that has the search input.
    if ($('#jita-log-search').length) {
        var jitaApplyLogFilter = function () {
            // Drop the previous Nx badges before measuring row text, so a stale "52×" can't pollute the search
            // match; jitaRegroupLog() re-adds them from the new visibility at the end of this pass.
            var pb = document.querySelectorAll('#tableContent .jita-rep-badge');
            for (var pi = 0; pi < pb.length; pi++) { if (pb[pi].parentNode) { pb[pi].parentNode.removeChild(pb[pi]); } }
            var q = ($('#jita-log-search').val() || '').toLowerCase();
            var off = {};
            $('#gnav a.toggle').each(function () { off[$(this).attr('id')] = true; });
            var onlyExc = off.notice && off.warning && off.error && !off.exception;   // the "Only Exceptions" state
            $('#tableContent tbody tr').each(function () {
                var cls = this.className || '';
                var hiddenByToggle = onlyExc
                    ? !/\bexception\b/.test(cls)
                    : ((off.notice && /\bnotice\b/.test(cls)) ||
                       (off.warning && /\bwarning\b/.test(cls)) ||
                       (off.error && /\berror\b/.test(cls)) ||
                       (off.exception && /\bexception\b/.test(cls)));
                var matches = !q || (this.textContent || '').toLowerCase().indexOf(q) >= 0;
                this.style.display = (!hiddenByToggle && matches) ? 'table-row' : 'none';
            });
            // Re-collapse identical runs against the visibility we just computed (hiding a type can make
            // previously-separated duplicates adjacent, so the "Nx" grouping must be recalculated here).
            jitaRegroupLog();
        };
        var jitaSearchTimer = null;
        $('#jita-log-search').on('input', function () {
            if (jitaSearchTimer) { clearTimeout(jitaSearchTimer); }
            jitaSearchTimer = setTimeout(jitaApplyLogFilter, 120);   // debounce for large logs
        });
        // Re-apply the text filter after any toggle / Only-Exceptions / Show-All click so the two compose.
        $('#gpanel a').on('click', function () { setTimeout(jitaApplyLogFilter, 0); });
    }
};


// Normalize the raw log text (collapse tab runs + blank lines, flatten "***…***" logging errors, escape <)
// and split into rows. Shared preamble of the four Parse* functions; assigns + returns the module `rows` array.
function prepLogRows() {
    rows = rows.replace(/(\t{2,})+/g, "\t").replace(/([\r\n]){2,}/g, "\r\n").replace(/([\r\n])[*]{3}(.*)(?=[*]{3})[*]{3}/g, "\r\n\t\t\tLogging error occurred").replace(/[\<]/g, function (c) { return "&lt;"; }).replace(/\n$/, "").split("\n");
    return rows;
}

// Hide the loader and reveal the filled table. Shared epilogue of the four Parse* functions.
function finishParserView() {
    document.getElementById("loader").style.display = "none";
    document.getElementById("tableContent").style.display = "table";
}


// Process the methodcalls logs and display them in a more readable state than the default
function ParseMcLogs() {
    var averageDuration = 0;
    var count = 0;
    var peak = 0;
    prepLogRows();

 /**
 * Object to which we save the table
 */
    var logs = {};
    logs.tableInfo = [];


 /**
 * Adds each row from 'rows' to the 'tableContent' table.
 * rowQuantity: Quantity of rows which will be loaded
 */
    logs.showRow = function(rowQuantity) {
        var table = logs.tableInfo;
        var tableContent = document.getElementById('tableContent');
        var tableContentRowsLength = 0;
        var toIndex = tableContentRowsLength + rowQuantity;
        for (var i = tableContentRowsLength, row, cellIndex, dateTime, method, duration, macho; i < toIndex; ++i) {
            row = document.createElement('tr');
            row.className = 'row';
            cellIndex = -1;
            dateTime = row.insertCell(++cellIndex);
            dateTime.innerHTML = table[i][0];
            method = row.insertCell(++cellIndex);

            if (table[i][1] == "machoNet::GetTime (RemoteServiceCall)") {
                macho = true;
            }
            else {
                macho = false;
            }

            method.innerHTML = table[i][1];
            duration = row.insertCell(++cellIndex);

            if (table[i][2] >= 1500) {
                row.className = 'red';
            }
            else if (table[i][2] >= 500) {
                row.className = 'yellow';
            }

            if (macho & table[i][2] >= Number(peak)) {
                $('.peakMachoCell').each(function() {$(this).removeClass('peakMachoCell')})
                row.className += ' peakMachoCell'
            }

            duration.innerHTML = table[i][2];

            tableContent.tBodies[0].appendChild(row);
        }
    };

 /**
 * Fill the table with the log data
 */
    for (var i = 1; i < rows.length; ++i) {
        var cols = rows[i].split("\t");

        if (cols[1] == "machoNet::GetTime (RemoteServiceCall)") {
            averageDuration = averageDuration + Number(cols[2]);
            count++;
            if (Number(peak) < Number(cols[2])) {
                peak = cols[2];
            }
        }

        logs.tableInfo.push([cols[0], cols[1], cols[2]]);
    }
    $('#averageMacho').html('Average machoNet::GetTime duration: ' + Math.round(averageDuration / count) + 'ms <i class="fa-regular fa-circle-question" title="machoNet::GetTime is similar to the ping between the client and the EVE proxy.\nIf GetTime is bad / spiky then there are likely internet or client computer/network issues present.\nIf GetTime is stable and low but other calls are spiking then you can assume that there was some sort of server issue."></i>');
    $('#peakMacho').html('Peak machoNet::GetTime duration: ' + peak + 'ms <i class="fa-regular fa-circle-question" title="Clicking this row scrolls to the highest GetTime value withing this log file."></i>');
    $('#peakMacho').on('click', function(){$(".peakMachoCell")[0].scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" })})
    logs.showRow((rows.length - 2));



 /**
 * Remove the loader and show the content
 */
    finishParserView();
};


// Process the outstandingcalls logs and display them in a more readable state than the default
function ParseOcLogs() {
    prepLogRows();

 /**
 * Object to which we save the table
 */
    var logs = {};
    logs.tableInfo = [];


 /**
 * Adds each row from 'rows' to the 'tableContent' table.
 * rowQuantity: Quantity of rows which will be loaded
 */
    logs.showRow = function(rowQuantity) {
        var table = logs.tableInfo;
        var tableContent = document.getElementById('tableContent');
        var tableContentRowsLength = 0;
        var toIndex = tableContentRowsLength + rowQuantity;
        for (var i = tableContentRowsLength, row, cellIndex, dateTime, method; i < toIndex; ++i) {
            if (table[i][0] == "") {
                break;
            }
            row = document.createElement('tr');
            row.className = 'row';
            cellIndex = -1;
            dateTime = row.insertCell(++cellIndex);
            dateTime.innerHTML = table[i][0];
            method = row.insertCell(++cellIndex);
            method.innerHTML = table[i][1];

            tableContent.tBodies[0].appendChild(row);
        }
    };

 /**
 * Fill the table with the log data
 */
    for (var i = 0; i < rows.length; ++i) {
        var cols = rows[i].split(" - ");
        logs.tableInfo.push([cols[0], cols[1]]);
    }

    logs.showRow((rows.length));



 /**
 * Remove the loader and show the content
 */
    finishParserView();
};


// Process the processHealth logs and display them in a more readable state than the default
function ParsePhLogs() {
    prepLogRows();

 /**
 * Object to which we save the table
 */
    var logs = {};
    logs.tableInfo = [];


 /**
 * Adds each row from 'rows' to the 'tableContent' table.
 * rowQuantity: Quantity of rows which will be loaded
 */
    logs.showRow = function(rowQuantity) {
        var table = logs.tableInfo;
        var tableContent = document.getElementById('tableContent');
        var tableContentRowsLength = 0;
        var toIndex = tableContentRowsLength + rowQuantity;
        for (var i = tableContentRowsLength, row, cellIndex, dateTime, pyDateTime, procCpu, threadCpu, pyMem, virtualMem, taskletsProcessed, taskletsQueued, watchdogTime, spf, serviceCalls, callsFromClient, bytesReceived, bytesSent, packetsReceived, packetsSent, sessionCount, tidiFactor; i < toIndex; ++i) {
            row = document.createElement('tr');
            row.className = 'row';
            cellIndex = -1;
            dateTime = row.insertCell(++cellIndex);
            dateTime.innerHTML = table[i][0];
            pyDateTime = row.insertCell(++cellIndex);
            pyDateTime.innerHTML = table[i][1];
            procCpu = row.insertCell(++cellIndex);
            procCpu.innerHTML = Math.round(Number(table[i][2]));
            threadCpu = row.insertCell(++cellIndex);
            threadCpu.innerHTML = Math.round(Number(table[i][3]));
            pyMem = row.insertCell(++cellIndex);
            pyMem.innerHTML = Math.round(Number(table[i][4]));;
            virtualMem = row.insertCell(++cellIndex);
            virtualMem.innerHTML = Math.round(Number(table[i][5]));
            taskletsProcessed = row.insertCell(++cellIndex);
            taskletsProcessed.innerHTML = table[i][6];
            taskletsQueued = row.insertCell(++cellIndex);
            taskletsQueued.innerHTML = table[i][7];
            watchdogTime = row.insertCell(++cellIndex);
            watchdogTime.innerHTML = Number(table[i][8]);
            spf = row.insertCell(++cellIndex);

            if (Number(table[i][9]) >= "0.0666666666666667") {
                spf.className += 'red';
            }
            else if (Number(table[i][9]) >= "0.0333333333333333") {
                spf.className += 'yellow';
            }

            spf.innerHTML = Math.round(1 / Number(table[i][9]) *10000) /10000;
            serviceCalls = row.insertCell(++cellIndex);
            serviceCalls.innerHTML = table[i][10];
            callsFromClient = row.insertCell(++cellIndex);
            callsFromClient.innerHTML = table[i][11];
            bytesReceived = row.insertCell(++cellIndex);
            bytesReceived.innerHTML = table[i][12];
            bytesSent = row.insertCell(++cellIndex);
            bytesSent.innerHTML = table[i][13];
            packetsReceived = row.insertCell(++cellIndex);
            packetsReceived.innerHTML = table[i][14];
            packetsSent = row.insertCell(++cellIndex);
            packetsSent.innerHTML = table[i][15];
            sessionCount = row.insertCell(++cellIndex);

            if (table[i][16] >= "2") {
                sessionCount.className += 'red';
            }

            sessionCount.innerHTML = table[i][16];
            tidiFactor = row.insertCell(++cellIndex);

            if (table[i][17] <= "0.2") {
                tidiFactor.className += 'red';
            }
            else if (table[i][17] <= "0.8") {
                tidiFactor.className += 'yellow';
            }
            else if (table[i][17] >= "1.05") {
                tidiFactor.className += 'red';
            }


            tidiFactor.innerHTML = table[i][17];
            tableContent.tBodies[0].appendChild(row);
        }
    };

 /**
 * Fill the table with the log data
 */
    for (var i = 1; i < rows.length; ++i) {
        var cols = rows[i].split("\t");
        logs.tableInfo.push([cols[0], cols[1], cols[2], cols[3], cols[4], cols[5], cols[6], cols[7], cols[8], cols[9], cols[10], cols[11], cols[12], cols[13], cols[14], cols[15], cols[16], cols[17]]);
    }
    logs.showRow((rows.length - 2));

 /**
 * Clickhandler for when the user clicks on the FPS /spf row. We toggle between spf and FPS on click
 */
    var clickHandler = function() {
        return function() {
            let FPS = 'FPS <i class="fa-regular fa-circle-question" title="Frames per second"></i>'
            let spf = 'spf <i class="fa-regular fa-circle-question" title="Seconds per frame"></i>'
            $('#tableContent > thead > tr > th:nth-child(10)').html($(this).html() == FPS ? spf : FPS);
            $('#tableContent > tbody > tr > td:nth-child(10)').each(function() {
                $(this).text(Math.round(1 / $(this).text() *10000) /10000);
            });
        };
    };
    $('#tableContent > thead > tr > th:nth-child(10)').on('click', clickHandler());


 /**
 * Remove the loader and show the content
 */
    finishParserView();
};



// Process the logs and display them in a more readable state than the default
function ParseLogs() {
    prepLogRows();

 /**
 * Object to which we save the table
 */
    var logs = {};
    logs.tableInfo = [];

 /**
 * Adds each row from 'rows' to the 'tableContent' table.
 * rowQuantity: Quantity of rows which will be loaded
 */
    logs.showRow = function(rowQuantity) {
        var excTime, sttTime = "";
        var table = logs.tableInfo;
        var tableContent = document.getElementById('tableContent');
        var tableContentRowsLength = 0;
        var toIndex = tableContentRowsLength + rowQuantity;
        for (var i = tableContentRowsLength, row, cellIndex, timeCell, facilityCell, typeCell, messageCell, clickHandler; i < toIndex; ++i) {
            row = document.createElement('tr');
            row.className = 'row';
            cellIndex = -1;
            timeCell = row.insertCell(++cellIndex);
            timeCell.innerHTML = table[i][0];
            facilityCell = row.insertCell(++cellIndex);
            facilityCell.innerHTML = table[i][1];
            typeCell = row.insertCell(++cellIndex);


 /**
 * Switch for checking if the current row is a notice, warning, error or info message
 * and add the according class to the row
 */
            switch (table[i][2]) {
                case 'notice':
                    row.className = 'notice';
                    break;
                case 'warning':
                    row.className = 'warning';
                    break;
                case 'error':
                    row.className = 'error';
                    break;
                default:
                    row.className = 'info';
                    break;
            }

 /**
 * Check if the message contains the beginning of an exception and set excTime (Exception time) to the time of the current message
 * Also adds a border to the top of the row
 */
            if (table[i][3].indexOf("EXCEPTION #") >= 0) {
                excTime = table[i][0];
                row.className += ' bordertop';
            }


 /**
 * Check if the message contains the beginning of a stacktrace,
 * then set sttTime (Stacktrace time) to the time of the current message and add a border to the top of the row
 */
            if (table[i][3].indexOf("STACKTRACE #") >= 0) {
                sttTime = table[i][0];
                row.className += ' bordertop';
            }


 /**
 * If the time of the current message is the same time as it was when the exception started
 * then add the 'exception' class to the row
 */
            if (table[i][0] == excTime) {
                row.className += ' exception';
            }


 /**
 * If there is an "Exception End" message in the current log row,
 * then add the 'borderbot' class to the row and set excTime to its default value
 */
            if (table[i][3].indexOf("EXCEPTION END") >= 0) {
                row.className += ' borderbot';
                excTime = "";
            }


 /**
 * If excTime is not empty but it doesnt match the time of the current row,
 * then add the 'borderbot' class to the row and set excTime to its default value
 */
            if (excTime != "" && table[i][0] != excTime) {
                row.className += ' bordertop';
                excTime = "";
            }


 /**
 * If there is an "Stacktrace End" message in the current log row,
 * then add the 'borderbot' class to the row and set sttTime to its default value
 */
            if (table[i][3].indexOf("STACKTRACE END") >= 0) {
                row.className += ' borderbot';
                sttTime = "";
            }


 /**
 * If sttTime is not empty but it doesnt match the time of the current row,
 * then add the 'borderbot' class to the row and set sttTime to its default value
 */
            if (sttTime != "" && table[i][0] != sttTime) {
                row.className += ' bordertop';
                sttTime = "";
            }


            typeCell.innerHTML = table[i][2];
            messageCell = row.insertCell(++cellIndex);
            messageCell.innerHTML = table[i][3];
            // (Known-exception highlighting is applied as a post-render pass in ParseLogs via
            //  JiTA.logsig.applyToTable(), since the signature index is built async from IndexedDB.)


 /**
 * Currently unused clickHandler
 */
            clickHandler = function(row) {
                return function() {
                    logs.loadItemInformation(table[row][0]);
                };
            };
            //row.onclick = clickHandler(i);
            tableContent.tBodies[0].appendChild(row);
        }
    };


 /**
 * Fill the table with the log data
 */
    for (var i = 1; i < rows.length; ++i) {
        var cols = rows[i].split("\t");
        logs.tableInfo.push([cols[0], cols[1], cols[2], cols[3]]);
    }
    logs.showRow((rows.length - 1));


 /**
 * Remove the loader and show the content
 */
    finishParserView();

 /**
 * "Group Repeats": segment the rendered rows into line / exception-block units and collapse consecutive
 * identical ones into a single row with an "Nx" badge. Built BEFORE the async signature pass (so signatures
 * are read from pristine message text) and grouped once for the initial (unfiltered) view; jitaApplyLogFilter
 * re-runs the collapse after every filter / toggle so the batching tracks what's currently visible.
 */
    jitaBuildLogGroups();
    jitaRegroupLog();

 /**
 * Feature D: flag log lines that match a known exception signature mined from the defect DB, linking each
 * back to its defect. Runs async (index is built from IndexedDB) and patches the rendered rows in place.
 */
    if (typeof JiTA !== 'undefined' && JiTA.logsig) { JiTA.logsig.applyToTable(); }
};


/* ---- "Group Repeats": collapse consecutive identical log lines / exception blocks (main Log Parser) ----
 * A run of consecutive IDENTICAL events - either a single line, or a whole EXCEPTION #…EXCEPTION END block -
 * is collapsed to its first occurrence with an "Nx" count badge. "Identical" compares facility + type +
 * message with the TIMESTAMP column excluded, so the same thing logged repeatedly (each with a different
 * time) still groups.
 *
 * Crucially the collapse is recomputed by jitaRegroupLog() AFTER every filter / toggle pass, not once at parse
 * time: hiding a message type (e.g. Notices) can make two identical errors - previously separated by a notice
 * - become visually adjacent and therefore groupable. So jitaBuildLogGroups() runs ONCE (stamping each row with
 * a unit id + a timestamp-free signature), and jitaRegroupLog() re-derives the badges from the CURRENT
 * visibility on demand. A hidden unit between two duplicates is skipped (it doesn't break the run), which is
 * exactly what makes "hide notices -> the errors around them batch together" work.
 *
 * The collapsed follower rows stay hidden - the "Nx" badge is an informational count only, not a toggle.
 * (The "Group Repeats" nav button is the way to see every raw line again.)
 */

// Segment the rendered rows into "units" (a single line, or a full exception block) and stamp each row with
// its unit id (data-jita-grp) + the unit's timestamp-free signature (data-jita-gsig on the unit's first row).
// Runs once, right after the table is filled and BEFORE applyToTable rewrites any message cell, so the
// signature is computed from the pristine message text.
function jitaBuildLogGroups() {
    var tbody = document.querySelector('#tableContent tbody');
    if (!tbody) { return; }
    var rows = tbody.rows, i = 0, unit = 0;
    function cellText(tr, idx) { var c = tr.cells[idx]; return c ? (c.textContent || '') : ''; }
    // Normalize the volatile bits that differ between repeats of the SAME exception so they still group. The
    // header line ("EXCEPTION #5 logged at 03/12/2025 15:23:55") carries a per-instance counter AND a date/
    // time INSIDE the message column, so without this every block's signature is unique and identical
    // exceptions never batch. We also collapse the STACKTRACE counter, the per-instance Stackhash, and
    // object-repr hex addresses (0x…), all of which vary between otherwise-identical dumps. (The row's own
    // Time column is already excluded from the signature.)
    function normSig(msg) {
        return msg
            .replace(/(EXCEPTION|STACKTRACE)\s+#\d+/gi, '$1 #')   // per-instance exception / stacktrace counter
            .replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, '#')           // dates (DD/MM/YYYY or MM/DD/YYYY)
            .replace(/\d{1,2}:\d{2}:\d{2}/g, '#')                 // times (HH:MM:SS)
            .replace(/Stackhash\s*:\s*-?\d+/gi, 'Stackhash: #')   // per-instance stack hash
            .replace(/0x[0-9a-fA-F]+/gi, '0x#');                  // object-repr / memory addresses
    }
    function sigOf(tr) { return cellText(tr, 1) + '\x1f' + cellText(tr, 2) + '\x1f' + normSig(cellText(tr, 3)); }   // facility|type|normalized message (time excluded)
    while (i < rows.length) {
        var start = i, sig;
        if (cellText(rows[i], 3).indexOf('EXCEPTION #') !== -1) {
            // Exception BLOCK: gather rows until EXCEPTION END (inclusive) or the next EXCEPTION # - the same
            // segmentation JiTA.logsig uses - so a whole repeated dump collapses as one unit.
            var parts = [sigOf(rows[i])];
            i++;
            for (; i < rows.length; i++) {
                var mt = cellText(rows[i], 3);
                if (mt.indexOf('EXCEPTION #') !== -1) { break; }
                parts.push(sigOf(rows[i]));
                if (mt.indexOf('EXCEPTION END') !== -1) { i++; break; }
            }
            // EVE emits an empty error line after every EXCEPTION END. Absorb that trailing blank line (or
            // several) into THIS block's ROW RANGE - but deliberately NOT into its signature `parts` - so it
            // doesn't sit between two identical blocks as its own unit and break the run (which is what stops
            // consecutive repeated exceptions from grouping). Keeping it out of the signature also means a
            // stray trailing space can't make two otherwise-identical blocks look different.
            while (i < rows.length && cellText(rows[i], 3).trim() === '') { i++; }
            sig = 'B:' + parts.join('\x1e');
        } else {
            sig = 'L:' + sigOf(rows[i]);          // single LINE
            i++;
        }
        for (var r = start; r < i; r++) { rows[r].setAttribute('data-jita-grp', unit); }
        rows[start].setAttribute('data-jita-gsig', sig);
        unit++;
    }
}

// Re-derive the "Nx" badges from the CURRENT row visibility. Walks units in order, skipping any whose rows
// are all hidden (so a filtered-out unit does NOT break a run of duplicates around it), and collapses
// consecutive units that share a signature: the followers are hidden and the leader gets a count badge.
// Called at the end of jitaApplyLogFilter (after every toggle / search) and once from ParseLogs.
function jitaRegroupLog() {
    var tbody = document.querySelector('#tableContent tbody');
    if (!tbody) { return; }
    // Clear our previous badges idempotently (never touch applyToTable's [EDR-x] link - only our own spans).
    var oldBadges = tbody.querySelectorAll('.jita-rep-badge');
    for (var b = 0; b < oldBadges.length; b++) { if (oldBadges[b].parentNode) { oldBadges[b].parentNode.removeChild(oldBadges[b]); } }
    // Grouping disabled: the "Group Repeats" nav toggle carries .toggle when OFF. The rows already hold the
    // filter's base visibility (jitaApplyLogFilter reset every row before calling us), so just leave them.
    var btn = document.getElementById('jita-group-toggle');
    if (btn && btn.classList.contains('toggle')) { return; }

    var rows = tbody.rows;
    var runSig = null, runLeaderRow = null, runCount = 0, runFirstTime = '', runLastTime = '';

    function timeOf(tr) { var c = tr.cells[0]; return (c && c.textContent) || ''; }
    function stamp() {
        if (runCount <= 1 || !runLeaderRow) { return; }
        var msg = runLeaderRow.cells[runLeaderRow.cells.length - 1];
        if (!msg) { return; }
        var badge = document.createElement('span');
        badge.className = 'jita-rep-badge';
        badge.textContent = runCount + '×';   // informational count only (not a toggle)
        var span = (runFirstTime && runLastTime && runFirstTime !== runLastTime) ? (runFirstTime + ' → ' + runLastTime) : (runFirstTime || '');
        badge.title = runCount + ' identical in a row' + (span ? ' · ' + span : '');
        msg.insertBefore(badge, msg.firstChild);
    }

    var i = 0;
    while (i < rows.length) {
        // Collect this unit's rows (the consecutive run sharing one data-jita-grp); its signature lives on the
        // first row.
        var g = rows[i].getAttribute('data-jita-grp'), unitRows = [], sig = null;
        while (i < rows.length && rows[i].getAttribute('data-jita-grp') === g) {
            if (sig === null) { sig = rows[i].getAttribute('data-jita-gsig'); }
            unitRows.push(rows[i]);
            i++;
        }
        // Rows of this unit that the current filter/toggle state leaves visible.
        var visible = [];
        for (var v = 0; v < unitRows.length; v++) { if (unitRows[v].style.display !== 'none') { visible.push(unitRows[v]); } }
        if (!visible.length) { continue; }   // whole unit filtered out -> skip; do NOT break the current run

        if (sig !== null && sig === runSig) {
            // A duplicate of the current run's leader -> hide it (stays hidden; the badge is just a count).
            runCount++;
            runLastTime = timeOf(visible[visible.length - 1]) || runLastTime;
            for (var h = 0; h < unitRows.length; h++) { unitRows[h].style.display = 'none'; }
        } else {
            stamp();   // close the previous run
            runSig = sig;
            runLeaderRow = visible[0];
            runCount = 1;
            runFirstTime = timeOf(visible[0]);
            runLastTime = timeOf(visible[visible.length - 1]);
        }
    }
    stamp();   // close the final run
}


// CSS for all parsed Logs
var css = `
    * {
    color: #e6e6e6;
    }

	.pointer {
      cursor: pointer;
    }

    .peakMachoCell {
      border: solid thin;
      border-color: red;
    }

    #peakMacho {
      cursor: pointer;
      text-align: right;
      color: #e6e6e6;
    }

    #averageMacho {
      text-align: right;
      color: #e6e6e6;
    }

    #gpanel {
      position: fixed;
      top: 75px;
      left: 520px;
      box-sizing: border-box;
      width: auto;
      height: 43px;
      padding: 0 5px;
      overflow: visible;
    }

    #gheader {
      white-space: normal;
      z-index: 522;
    }

    #gpanel ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }

    #gpanel li {
      float: left;
      overflow: hidden;
      margin-top: 0px;
    }

    #gnav {
      float: left;
      overflow: hidden;
    }

    .red {
      background: #531a1a;
    }

    .yellow {
      background: #67670b;
    }

    td:first-child, th:first-child {
       padding: 4px 8px;
    }

    th {
      vertical-align: top;
      text-align: left;
      font-weight: bold;
      color: aliceblue;
      background-color: #282d33;
    }

    td {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: Courier New;
      font-size: 11px;
      font-weight: normal;
      border-right: 1.5px solid #aaaaaa;
    }

    #body {
      margin-top: -12px;
      overflow: auto;
      white-space: normal;
    }

    #body h1 {
      margin: 0;
      padding: 10px 20px 5px;
      border-bottom: 1px solid #CCC;
      color: #848589;
      font: 400 30px 'Segoe UI',Arial,Helvetica,sans-serif;
      height: 41px;
    }

    #table {
      position: absolute;
      top: 85px;
      bottom: 0;
      width: 100%;
      -webkit-transition: .3s linear;
      -moz-transition: .3s linear;
      transition: .3s linear;
      overflow-y: scroll;
      margin-top: 28px;
      background-color: #1D2125;
    }

    span[data-testid="code-block"] {
    background-color: #1d2125d6;
    }

    #table table {
      width: max-content;
      border-collapse: collapse;
      border-spacing: 0;
      -webkit-box-sizing: content-box;
      -moz-box-sizing: content-box;
      box-sizing: content-box;
      color: #e6e6e6;
    }

    #loader {
      position: absolute;
      left: 50%;
      top: 50%;
      z-index: 1;
      width: 150px;
      height: 150px;
      margin: -75px 0 0 -75px;
      border: 16px solid #f3f3f3;
      border-radius: 50%;
      border-top: 16px solid #3498db;
      width: 120px;
      height: 120px;
      -webkit-animation: spin 2s linear infinite;
      animation: spin 2s linear infinite;
    }

    @-webkit-keyframes spin {
      0% { -webkit-transform: rotate(0deg); }
      100% { -webkit-transform: rotate(360deg); }
    }

    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }

    .animate-bottom {
      position: relative;
      -webkit-animation-name: animatebottom;
      -webkit-animation-duration: 1s;
      animation-name: animatebottom;
      animation-duration: 1s
    }

    @-webkit-keyframes animatebottom {
      from { bottom:-100px; opacity:0 }
      to { bottom:0px; opacity:1 }
    }

    @keyframes animatebottom {
      from{ bottom:-100px; opacity:0 }
      to{ bottom:0; opacity:1 }
    }

    .fixedHead {
      overflow: auto;
      height: 100px;
    }

    .fixedHead thead th {
      position: sticky;
      top: 0;
      z-index: 1;
    }

    .floating-div {
      background-color: #333;
      padding: 10px 50px;
      color: #EEE;
      margin-top: 10px;
      position: fixed;
      top: 75px;
      right: 18px;
      width: calc(33.33% - 25px);
      white-space: normal;
      }
`

// Additional CSS only for the LogParser
var cssLogParser = `
    td:first-child, th:first-child {
       padding: 4px 8px;
    }

    th {
      vertical-align: top;
      text-align: left;
      font-weight: bold;
      background-color: #282d33;
      color: aliceblue;
    }

    td {
      vertical-align: top;
      text-align: left;
      font-family: Courier New;
      font-size: 11px;
      font-weight: normal;
      border-right: 1.5px solid #aaaaaa;
    }

    .row {
      background: #FFF;
    }

    .notice {
      background: #296429;
    }

    .warning {
      background: #67670b;
    }

    .error {
      background: #531a1a;
    }

    .info {
      background: #1f313d;
    }

    #gpanel {
      position: fixed;
      top: 15px;
      left: 175px;
      box-sizing: border-box;
      width: auto;
      height: 43px;
      padding: 0 5px;
      line-height: 46px;
      overflow: visible;
    }

	#gpanel a {
      display: block;
      padding: 0 10px;
      color: #FFF;
      font-weight: 700;
      text-decoration: none;
      white-space: nowrap;
      cursor: pointer;
      -webkit-transition: .1s ease-in-out;
      -moz-transition: .1s ease-in-out;
      -o-transition: 0.1s ease-in-out;
      transition: .1s ease-in-out;
    }

    #gpanel li a  {
      color: #FFF;
      background-color: #7B4;
      border: 1px solid black;
    }

	.toggle {
      color: #FFF;
      background-color: #8b8e89 !important;
      border: 1px solid black;
    }

    #button a  {
      color: #FFF;
      background-color: #7B4;
      border: 1px solid black;
    }

    #button a:hover {
      background-color: rgba(204,204,204,.4);
      color: #FFF;
    }

    .timeCol {
      width: 139.766px;
      text-align: center;
    }

    .facilityCol {
      width: 265px;
    }

    .typeCol {
      width: 70px;
    }

    .messageCol {
      width: auto;
    }

    .bordertop {
        border-top: 2px solid #aaaaaa;
    }

    .borderbot {
        border-bottom: 2px solid #aaaaaa;
    }

    #searchli {
      float: left;
      margin-left: 10px;
    }

    #jita-log-search {
      height: 26px;
      padding: 0 8px;
      border: 1px solid #555;
      border-radius: 4px;
      background: #1d2125;
      color: #e6e6e6;
      font-size: 12px;
      outline: none;
    }

    #jita-log-search:focus {
      border-color: #4c9aff;
    }

    .sig-hit {
      box-shadow: inset 4px 0 0 #ffb547 !important;
    }

    .sig-hit-loose {
      box-shadow: inset 4px 0 0 #6b7785 !important;
    }

    .jita-rep-badge {
      display: inline-block;
      margin-right: 6px;
      padding: 0 6px;
      border-radius: 8px;
      background: #3a434d;
      color: #ffd479;
      font-size: 10px;
      font-weight: 700;
      line-height: 16px;
      vertical-align: middle;
      user-select: none;
    }
`


// FontAwesome stylesheet, shared by every parser view.
var FA_LINK = '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">';

// Build a log-parser view: the shared <style> + FontAwesome + #body/#table/#tableContent/#loader shell around
// a given <h1> `title` and <thead> `columns` (raw <th> markup). opts.extraCss is appended after the base css
// (the main Log Parser layers cssLogParser on top); opts.header is HTML injected above #body (the filter nav
// on the main parser, the macho stats on Method Calls). One shell for all five, so the table structure and the
// FontAwesome link are single-sourced.
function parserShell(title, columns, opts) {
    opts = opts || {};
    return `
<style>
`+ css + (opts.extraCss || '') +`
</style>

`+ FA_LINK +`
<body>
`+ (opts.header || '') +`
   <div id="body">
      <header>
         <h1>`+ title +`</h1>
      </header>
      <div id="table" tabindex="0">
         <table id="tableContent" style="display:none;" class="fixedHead">
            <div id="loader"></div>
            <thead>
               <tr>
`+ columns +`
            </thead>
            <tbody></tbody>
         </table>
      </div>
   </div>
`;
}


// Variable which contains the UI of the Log Parser
var html = parserShell('Logfile Parser', `
                  <th scope="col">Time
                  <th scope="col">Facility
                  <th scope="col">Type
                  <th scope="col">Message`, {
    extraCss: cssLogParser,
    header: `
   <header id="gheader">
      <nav id="gpanel">
         <ul id="gnav">
            <li>
               <a href="#" id = "notice" class="">Toggle Notice</a>
            <li>
               <a href="#" id = "warning" class="">Toggle Warnings</a>
            <li>
               <a href="#" id = "error" class="">Toggle Errors</a>
            <li>
               <a href="#" id = "exception" class="">Toggle Exceptions</a>
            <li id="button">
               <a href="#" id = "onlyexception" class="">Only Exceptions</a>
            <li id="button">
               <a href="#" id = "showAll">Show All</a>
            <li id="button">
               <a href="#" id = "jita-group-toggle" class="" title="Collapse consecutive identical lines / exceptions into one row with an Nx count. Recomputed as you filter, so hiding a message type re-batches whatever becomes adjacent.">Group Repeats</a>
            <li id="searchli">
               <input id="jita-log-search" type="text" placeholder="Filter…" autocomplete="off">
         </ul>
      </nav>
   </header>`
});



// Variable which contains the UI of the Process Health parser
var phHtml = parserShell('Process Health', `
                  <th scope="col">dateTime <i class="fa-regular fa-circle-question" title="System date / time converted into UTC"></i>
                  <th scope="col">pyDateTime
                  <th scope="col">procCpu <i class="fa-regular fa-circle-question" title="CPU usage in % of one CPU core"></i>
                  <th scope="col">threadCpu <i class="fa-regular fa-circle-question" title="CPU usage in % for the python thread"></i>
                  <th scope="col">pyMem <i class="fa-regular fa-circle-question" title="Memory usage for the python part of the client in MB"></i>
                  <th scope="col">virtualMem <i class="fa-regular fa-circle-question" title="Total memory usage of the client in MB"></i>
                  <th scope="col">taskletsProcessed <i class="fa-regular fa-circle-question" title="How many python threads have been run"></i>
                  <th scope="col">taskletsQueued <i class="fa-regular fa-circle-question" title="How many python threads are waiting to be run"></i>
                  <th scope="col">watchdog time <i class="fa-regular fa-circle-question" title="Time spent for watchdog in ms"></i>
                  <th scope="col" class="pointer">FPS <i class="fa-regular fa-circle-question" title="Frames per second"></i></th>
                  <th scope="col">serviceCalls
                  <th scope="col">callsFromClient
                  <th scope="col">bytesReceived <i class="fa-regular fa-circle-question" title="Bytes recieved from the EVE Server (Not including chat, imageserver and other services)"></i>
                  <th scope="col">bytesSent <i class="fa-regular fa-circle-question" title="Bytes sent to the EVE Server (Not including chat, imageserver and other services)"></i>
                  <th scope="col">packetsReceived <i class="fa-regular fa-circle-question" title="Packets recieved from the EVE Server (Not including chat, imageserver and other services)"></i>
                  <th scope="col">packetsSent <i class="fa-regular fa-circle-question" title="Bytes sent to the EVE Server (Not including chat, imageserver and other services)"></i>
                  <th scope="col">sessionCount <i class="fa-regular fa-circle-question" title="Should always be 1"></i>
                  <th scope="col">tidiFactor <i class="fa-regular fa-circle-question" title="Time Dilation - 1.0 = No TiDi"></i>`);


// Variable which contains the UI of the Method Calls parser
var McHtml = parserShell('Method Calls', `
                  <th scope="col">Time <i class="fa-regular fa-circle-question" title="System date / time converted into UTC"></i>
                  <th scope="col">Method <i class="fa-regular fa-circle-question" title="Python method which was called"></i>
                  <th scope="col">Duration in ms <i class="fa-regular fa-circle-question" title="How long it took to complete the method call"></i>`, {
    header: `
  <header id="gheader">
      <nav id="gpanel">
         <ul id="gnav">
            <li>
               <div id="averageMacho"> Average machoNet::GetTime duration:</div>
               <div id="peakMacho"> Peak machoNet::GetTime duration:</div>
         </ul>
      </nav>
   </header>`
});


// Variable which contains the UI of the Outstanding Calls parser
var ocHtml = parserShell('Outstanding Calls', `
                  <th scope="col">Time <i class="fa-regular fa-circle-question" title="System date / time converted into UTC"></i>
                  <th scope="col">Method <i class="fa-regular fa-circle-question" title="Python method which was called but is not yet finished"></i>`);


// Variable which contains the UI of the Last Crashes parser
var lcHtml = parserShell('Last Crashes', `
                  <th scope="col">Time <i class="fa-regular fa-circle-question" title="System date / time converted into UTC"></i>
                  <th scope="col">Crash ID`);


/* ---- EVE system-requirements check (Quick Info on PDMData.txt) ----
 * Data-driven replacement for the old hardcoded min/rec objects + the 8-case switch(true). The floors are
 * transcribed from the official article (bump `verified` when you refresh them). Each component is judged
 * independently against a { min, rec } pair; the overall verdict is the WORST component, so the Quick Info box
 * can show WHICH part falls short instead of a bare pass/fail. Every getter is guarded, so a missing or
 * array-shaped PDM field yields an "n/a" row rather than NaN-poisoning the verdict or throwing (the old code
 * broke on hybrid-GPU laptops, where MACHINE.GPUS.GPU is an array). CPU/GPU are judged by the numeric proxies
 * PDMData actually reports (threads, frequency, VRAM) - we can't match specific CPU/GPU model names.
 */
var _MiB = 1048576, _GiB = 1073741824;
var EVE_REQ = {
    source: 'https://support.eveonline.com/hc/en-us/articles/5885219196828-System-Requirements',
    verified: '2026-08-08',
    // Windows: min = Win10 / dual-core @2.0GHz / 4GB / 1GB VRAM / DX11(FL11);  rec = Win11 / i7-7700|R7-1700
    // @3.6GHz / 16GB / 4GB VRAM. (Cores/frequency are a rough proxy for the named recommended CPUs.)
    windows: {
        osBuild:     { min: 10240, rec: 22000, minName: 'Windows 10', recName: 'Windows 11' },
        cpuMinCores: 2, cpuMinMhz: 2000, cpuRecCores: 8,   // rec judged by THREAD count, not base clock (see reqCpuTier)
        ram:         { min: 4 * _GiB, rec: 16 * _GiB },
        vram:        { min: 1024 * _MiB, rec: 4 * _GiB },
        dx:          { min: 11, rec: 11 }
    },
    // macOS: min = Monterey(12) / i5 @2.5GHz or Apple M1 / 4GB;  rec = Tahoe(26) / i7 @3.8GHz or M1 Pro / 16GB
    // / 8GB VRAM. The minimum Mac GPUs (Intel HD 4000 / Apple iGPU) have no stated VRAM floor.
    macos: {
        osMajor:        { min: 12, rec: 26, minName: 'macOS Monterey (12)', recName: 'macOS Tahoe (26)' },
        cpuMinIntelMhz: 2500, cpuRecIntelCores: 8,   // Intel: i5 @2.5 base min; i7 (>=8 threads) rec
        appleCores:     { min: 8, rec: 10 },          // M1 ~8 cores (min), M1 Pro ~10 (rec)
        ram:            { min: 4 * _GiB, rec: 16 * _GiB },
        vram:           { min: 0, rec: 8 * _GiB }
    }
};

// Tier of a numeric `val` against a { min, rec } spec: 'rec' when >= rec, 'min' when >= min, else 'fail';
// missing / non-numeric -> 'na'. `tol` (0..1) relaxes both thresholds (RAM/VRAM report a little under nominal
// - hardware-reserved / iGPU-stolen - so a genuine 16GB box shouldn't fail a 16GB bar).
function reqTier(val, spec, tol) {
    var v = Number(val);
    if (val == null || val === '' || isNaN(v)) { return 'na'; }
    var f = 1 - (tol || 0);
    if (v >= spec.rec * f) { return 'rec'; }
    if (v >= spec.min * f) { return 'min'; }
    return 'fail';
}

// Worst tier across a list (fail < min < rec); 'na' entries are ignored. Also computes the OVERALL verdict
// (the worst component). Returns 'na' only when every entry is 'na'.
function worstTier(tiers) {
    var order = { fail: 0, min: 1, rec: 2 }, w = null;
    for (var i = 0; i < tiers.length; i++) {
        var t = tiers[i];
        if (t === 'na') { continue; }
        if (w === null || order[t] < order[w]) { w = t; }
    }
    return w || 'na';
}

// CPU tier. Base frequency (PDM's FREQUENCY_MHZ) is a POOR recommended-tier signal: modern many-core CPUs
// report a low BASE clock (e.g. the i9-13900HX = 32 threads @ 2.2 GHz base, boosting past 5 GHz), so a
// freq-based rec bar wrongly demotes them. So RECOMMENDED is judged by logical-core (thread) count - the named
// recommended CPUs (i7-7700, Ryzen 7 1700) are all >= 8 threads - and frequency is used only as a MINIMUM
// floor. Apple Silicon is judged purely on core count.
function reqCpuTier(platform, vendor, cores, mhz) {
    var c = Number(cores), m = Number(mhz);
    var haveC = !isNaN(c) && c > 0, haveM = !isNaN(m) && m > 0;
    if (!haveC && !haveM) { return 'na'; }
    if (platform === 'mac' && /apple/i.test(vendor)) { return reqTier(c, EVE_REQ.macos.appleCores); }
    var recCores = (platform === 'mac') ? EVE_REQ.macos.cpuRecIntelCores : EVE_REQ.windows.cpuRecCores;
    var minMhz   = (platform === 'mac') ? EVE_REQ.macos.cpuMinIntelMhz  : EVE_REQ.windows.cpuMinMhz;
    var minCores = (platform === 'mac') ? 2 : EVE_REQ.windows.cpuMinCores;
    if (haveC && c >= recCores) { return 'rec'; }                                   // enough threads -> recommended
    if ((!haveC || c >= minCores) && (!haveM || m >= minMhz)) { return 'min'; }     // dual-core+ and >= min base clock
    return 'fail';
}

// PDM lists a single GPU as an object and multiple GPUs as an array. The GPU EVE actually uses is the one with
// the most VRAM (the discrete card on a hybrid laptop), so judge/report that one.
function pdmGpus(machine) {
    var g = machine && machine.GPUS && machine.GPUS.GPU;
    if (!g) { return []; }
    return Array.isArray(g) ? g : [g];
}
function pdmBestGpu(machine) {
    var list = pdmGpus(machine), best = null, bestV = -1;
    for (var i = 0; i < list.length; i++) {
        var v = Number(list[i].VIDEO_MEMORY);
        if (!isNaN(v) && v > bestV) { bestV = v; best = list[i]; }
    }
    return best || list[0] || null;
}
function pdmGpuName(gpu) {
    if (!gpu) { return ''; }
    return gpu.NAME || gpu.MODEL || gpu.DESCRIPTION || gpu.DEVICE || gpu.RENDERER || '';
}

function fmtGB(bytes) {
    var b = Number(bytes);
    if (isNaN(b) || b <= 0) { return '?'; }
    var gb = b / _GiB;
    return (Math.abs(gb - Math.round(gb)) < 0.1 ? Math.round(gb) : Math.round(gb * 10) / 10) + ' GB';
}
function fmtGHz(mhz) {
    var m = Number(mhz);
    if (isNaN(m) || m <= 0) { return '?'; }
    return (Math.round(m / 100) / 10) + ' GHz';
}
function reqEscape(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
}

// ---- detail-string builders (the right-hand "actual value (need)" column) ----
function reqCpuDetail(vendor, cores, mhz) {
    var v = /amd/i.test(vendor) ? 'AMD' : (/intel/i.test(vendor) ? 'Intel' : (/apple/i.test(vendor) ? 'Apple' : (vendor || 'CPU')));
    var parts = [v];
    if (!isNaN(cores) && cores > 0) { parts.push(cores + (cores === 1 ? ' thread' : ' threads')); }
    if (!isNaN(mhz) && mhz > 0) { parts.push('@ ' + fmtGHz(mhz) + ' base'); }
    return parts.join(' · ');
}
function reqSizeDetail(bytes, spec, suffix) {
    var t = reqTier(bytes, spec, 0.03), s = fmtGB(bytes) + (suffix || '');
    if (t === 'fail') { s += ' - min ' + fmtGB(spec.min); }
    else if (t === 'min') { s += ' (rec ' + fmtGB(spec.rec) + ')'; }
    return s;
}
function reqGpuDetail(gpu, spec) {
    if (!gpu) { return 'no GPU reported'; }
    var name = pdmGpuName(gpu), vram = Number(gpu.VIDEO_MEMORY), out = name;
    if (!isNaN(vram) && vram > 0) { out = (name ? name + ' · ' : '') + reqSizeDetail(vram, spec, ' VRAM'); }
    return out || 'GPU';
}
function reqDriverInfo(gpu) {
    var out = { days: null, note: '' };
    var raw = gpu && gpu.DRIVER && gpu.DRIVER.DATE;
    if (!raw) { return out; }
    var p = String(raw).split('-');                 // PDM driver date is "MM-DD-YYYY"
    if (p.length !== 3) { return out; }
    var t = Date.parse(p[2] + '-' + p[0] + '-' + p[1]);
    if (isNaN(t)) { return out; }
    out.days = Math.ceil((new Date() - t) / (1000 * 3600 * 24));
    out.note = 'The graphics driver is ' + out.days + ' days old.' + (out.days > 365 ? ' ⚠ Consider updating.' : '');
    return out;
}

// Evaluate a parsed PDMData object against EVE_REQ -> { overall, rows:[{label, tier, detail, floor?}], driver }.
function evalRequirements(pdm) {
    var data = (pdm && pdm.DATA) || {}, os = data.OS || {}, machine = data.MACHINE || {}, cpu = machine.CPU || {};
    var type = os.TYPE || '', vendor = cpu.VENDOR || '';
    var cores = Number(cpu.LOGICAL_CORE_COUNT), mhz = Number(cpu.FREQUENCY_MHZ);
    var gpu = pdmBestGpu(machine), rows = [];

    if (/win/i.test(type)) {
        var W = EVE_REQ.windows, build = Number(os.BUILD_NUMBER);
        var osName = isNaN(build) ? 'Windows ?' : (build >= W.osBuild.rec ? W.osBuild.recName : (build >= W.osBuild.min ? W.osBuild.minName : 'Windows (older)'));
        rows.push({ label: 'OS', tier: reqTier(build, W.osBuild), detail: osName + (isNaN(build) ? '' : ' · build ' + build) });
        rows.push({ label: 'CPU', tier: reqCpuTier('win', vendor, cores, mhz), detail: reqCpuDetail(vendor, cores, mhz) });
        rows.push({ label: 'RAM', tier: reqTier(machine.TOTAL_MEMORY, W.ram, 0.03), detail: reqSizeDetail(machine.TOTAL_MEMORY, W.ram) });
        rows.push({ label: 'GPU', tier: reqTier(gpu ? gpu.VIDEO_MEMORY : NaN, W.vram, 0.03), detail: reqGpuDetail(gpu, W.vram) });
        var dx = Number(os.GRAPHICS_APIS && os.GRAPHICS_APIS.D3D_HIGHEST_SUPPORT);
        rows.push({ label: 'DirectX', tier: reqTier(dx, W.dx), floor: true, detail: isNaN(dx) ? '?' : ('DirectX ' + dx + (dx < W.dx.min ? ' - need 11' : '')) });
    } else if (/mac/i.test(type)) {
        var M = EVE_REQ.macos, major = Number(os.MAJOR_VERSION);
        var mName = isNaN(major) ? 'macOS ?' : ('macOS ' + major + (os.MINOR_VERSION ? '.' + os.MINOR_VERSION : ''));
        rows.push({ label: 'OS', tier: reqTier(major, M.osMajor), detail: mName });
        var macCpuDetail = /apple/i.test(vendor) ? ('Apple Silicon' + (isNaN(cores) ? '' : ' · ' + cores + ' cores')) : reqCpuDetail(vendor, cores, mhz);
        rows.push({ label: 'CPU', tier: reqCpuTier('mac', vendor, cores, mhz), detail: macCpuDetail });
        rows.push({ label: 'RAM', tier: reqTier(machine.TOTAL_MEMORY, M.ram, 0.03), detail: reqSizeDetail(machine.TOTAL_MEMORY, M.ram) });
        var mv = gpu ? Number(gpu.VIDEO_MEMORY) : NaN;
        if (!isNaN(mv) && mv > 0) { rows.push({ label: 'GPU', tier: reqTier(mv, M.vram, 0.03), detail: reqGpuDetail(gpu, M.vram) }); }
        else { rows.push({ label: 'GPU', tier: 'na', detail: pdmGpuName(gpu) || 'integrated' }); }
    } else {
        rows.push({ label: 'OS', tier: 'fail', detail: 'Unsupported / unknown OS' + (type ? ' (' + type + ')' : '') });
    }

    return { overall: worstTier(rows.map(function (r) { return r.tier; })), rows: rows, driver: reqDriverInfo(gpu) };
}

// Render the verdict + per-component breakdown into #Requirements and the driver-age line into #driverAge.
function renderRequirements(pdm) {
    var res = evalRequirements(pdm);
    var ICON = { rec: '✓', min: '✓', fail: '✗', na: '–' };
    var COL  = { rec: '#7fdca4', min: '#ffd479', fail: '#ff8f8f', na: '#9aa6b2' };
    var HEAD = { rec: 'meets the <b>recommended</b> requirements', min: 'meets the <b>minimum</b> (but not recommended) requirements',
                 fail: '<b>does not</b> meet the minimum requirements', na: 'could not be evaluated' };
    var html = '<div style="font-weight:700; margin-bottom:6px; color:' + (COL[res.overall] || COL.na) + ';">This PC ' + HEAD[res.overall] + ' for EVE.</div>' +
        '<table style="border-collapse:collapse; font-size:13px; line-height:1.5;">';
    res.rows.forEach(function (r) {
        var badge = (!r.floor && (r.tier === 'rec' || r.tier === 'min'))
            ? ' <span style="font-size:9px; text-transform:uppercase; letter-spacing:.04em; color:' + COL[r.tier] + ';">' + r.tier + '</span>' : '';
        html += '<tr>' +
            '<td style="padding:0 8px 0 0; color:' + COL[r.tier] + '; font-weight:700; vertical-align:top;">' + ICON[r.tier] + '</td>' +
            '<td style="padding:0 10px 0 0; color:#cfd6dd; vertical-align:top; white-space:nowrap;">' + r.label + badge + '</td>' +
            '<td style="padding:0; color:#e6e6e6;">' + reqEscape(r.detail) + '</td>' +
            '</tr>';
    });
    html += '</table>';
    $('#Requirements').html(html);

    if (res.driver.days != null) {
        $('#driverAge').text(res.driver.note);
    } else {
        $('#driverAge').text('Graphics driver date unavailable.');
    }
}


// Function to convert the PDMData.txt into a javascript object
function convertTextToObject(text) {
    var lines = text.split("\n");
    var stack = [];
    var currentObject = {};
    var result = currentObject;
    var tabRegex = /^(\t*)/;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var tabs = line.match(tabRegex)[0].length;
        line = line.trim();

        if (line.startsWith("{") && line.endsWith("}")) {
            var newObject = {};

            if (stack.length > tabs) {
                stack.splice(tabs); // Go up to the appropriate nesting level
            }

            if (stack.length === 0) {
                result[line.substring(1, line.length - 1)] = newObject;
            } else {
                var parent = stack[stack.length - 1];
                var objectKey = line.substring(1, line.length - 1);

                if (!parent[objectKey]) {
                    parent[objectKey] = newObject;
                } else {
                    if (!Array.isArray(parent[objectKey])) {
                        parent[objectKey] = [parent[objectKey]];
                    }
                    parent[objectKey].push(newObject);
                }
            }

            currentObject = newObject;
            stack.push(currentObject);
        } else if (line.startsWith("}")) {
            stack.pop();
            currentObject = stack[stack.length - 1];
        } else if (line.includes(":")) {
            var keyValue = line.split(":");
            var key = keyValue[0].trim();
            var value = keyValue[1].trim();

            if (value === "{EMPTY}") {
                value = "";
            }

            currentObject[key] = value;
        }
    }

    return result;
}


// Floating Div for the PDMData.txt file which contains our "Quick Info" about the specs of the players PC
var pdmHtml = `
<style>
`+ css +`
</style>
<div class="floating-div">
  <div><h2>Quick Info:</h2></div>
  <div id="driverAge"></div>
  <div id="Requirements"></div>
</div>
`


/* ---- dxdiag.txt triage summary (Quick Info) ----
 * dxdiag has no header row, so it's opened by click like the other igbr files. We surface only the handful of
 * fields that help a Bug Hunter decide "EVE defect, or unstable machine?":
 *   1. WER crash history - the star. APPCRASH entries for exefile.exe (the EVE client) are the MOST relevant:
 *      they name the faulting module + exception code that took the client down. BlueScreen / LiveKernelEvent
 *      entries are decoded to bugcheck names; a nonzero count flags an unstable OS/hardware (the i9 13/14th-gen
 *      Raptor Lake pattern especially), so the report may not be an EVE bug at all.
 *   2. Whether dxdiag itself crashed probing Direct3D (a GPU/driver-trouble signal).
 *   3. GPU(s) + driver DATE (a universal recency signal - "is this driver ancient?"). The vendor version string
 *      is shown too, but it needs vendor-specific knowledge to read and is mostly a fallback for when the date
 *      field reads "Unknown" (which is common).
 * NB: WER history is CUMULATIVE over weeks and not tied to the reported session - it's context, not proof.
 */

// Common bugcheck (BSOD) codes. WER stores P1 as a hex string with no 0x; unknown codes fall back to raw hex.
var DX_BUGCHECK = {
    0xA: 'IRQL_NOT_LESS_OR_EQUAL', 0x1A: 'MEMORY_MANAGEMENT', 0x1E: 'KMODE_EXCEPTION_NOT_HANDLED',
    0x3B: 'SYSTEM_SERVICE_EXCEPTION', 0x50: 'PAGE_FAULT_IN_NONPAGED_AREA',
    0x7E: 'SYSTEM_THREAD_EXCEPTION_NOT_HANDLED', 0x7F: 'UNEXPECTED_KERNEL_MODE_TRAP',
    0x9F: 'DRIVER_POWER_STATE_FAILURE', 0xC2: 'BAD_POOL_CALLER', 0xC4: 'DRIVER_VERIFIER_DETECTED_VIOLATION',
    0xC5: 'DRIVER_CORRUPTED_EXPOOL', 0xD1: 'DRIVER_IRQL_NOT_LESS_OR_EQUAL', 0xEF: 'CRITICAL_PROCESS_DIED',
    0x109: 'CRITICAL_STRUCTURE_CORRUPTION', 0x116: 'VIDEO_TDR_ERROR', 0x117: 'VIDEO_TDR_TIMEOUT_DETECTED',
    0x124: 'WHEA_UNCORRECTABLE_ERROR', 0x133: 'DPC_WATCHDOG_VIOLATION', 0x139: 'KERNEL_SECURITY_CHECK_FAILURE',
    0x1000007E: 'SYSTEM_THREAD_EXCEPTION_NOT_HANDLED_M', 0x1000008E: 'KERNEL_MODE_EXCEPTION_NOT_HANDLED_M'
};
// Common NT exception codes (BSOD P2 on some bugchecks; APPCRASH P7).
var DX_EXCEPTION = {
    'c0000005': 'ACCESS_VIOLATION', '80000003': 'BREAKPOINT', 'c000001d': 'ILLEGAL_INSTRUCTION',
    'c0000094': 'INTEGER_DIVIDE_BY_ZERO', 'c00000fd': 'STACK_OVERFLOW', 'c0000374': 'HEAP_CORRUPTION',
    'c0000409': 'STACK_BUFFER_OVERRUN', 'c0000420': 'ASSERTION_FAILURE', 'e06d7363': 'C++ exception (SEH)'
};
function dxBugcheckName(hex) {
    var n = parseInt(hex, 16);
    if (isNaN(n)) { return null; }
    return DX_BUGCHECK[n] || ('bugcheck 0x' + n.toString(16).toUpperCase());
}
function dxExceptionName(hex) {
    var key = String(hex == null ? '' : hex).toLowerCase().replace(/^0x/, '');
    return DX_EXCEPTION[key] || null;
}

// Parse the "Windows Error Reporting" section into [{ name, p:{P1..P10} }, ...] (dxdiag lists newest first).
function parseWER(text) {
    var out = [], idx = text.indexOf('Windows Error Reporting');
    if (idx < 0) { return out; }
    var blocks = text.substring(idx).split(/\+\+\+\s*WER\d+\s*\+\+\+/);
    for (var i = 1; i < blocks.length; i++) {
        var b = blocks[i];
        var nameM = b.match(/Event Name:\s*(.+)/);
        var p = {}, re = /\bP(\d+):[ \t]*([^\r\n]*)/g, m;
        while ((m = re.exec(b))) { p['P' + m[1]] = (m[2] || '').trim(); }
        out.push({ name: nameM ? nameM[1].trim() : 'Unknown', p: p });
    }
    return out;
}

// Classify a WER entry: 'eve' (exefile.exe crash), 'app' (other app crash), or 'kernel' (BSOD / live dump).
// App crashes put the faulting app's filename in P1; kernel dumps put a hex bugcheck code there instead.
function dxWerKind(e) {
    var p1 = e.p.P1 || '';
    if (/\.exe/i.test(p1)) { return /exefile\.exe/i.test(p1) ? 'eve' : 'app'; }
    if (/bluescreen|livekernel|kernel/i.test(e.name)) { return 'kernel'; }
    return 'app';
}

// First "Label: value" line in the dxdiag text (labels are right-aligned, so allow leading whitespace).
function dxFirst(text, label) {
    var esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var m = text.match(new RegExp('^[ \\t]*' + esc + '[ \\t]*:[ \\t]*([^\\r\\n]+)', 'im'));
    return m ? m[1].trim() : '';
}

// dxdiag dates use the reporter's locale (US default M/D/YYYY). Parse leniently; if the "month" is > 12 the
// locale must be D/M, so swap. Returns a Date or null.
function dxParseDate(s) {
    var m = String(s == null ? '' : s).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!m) { return null; }
    var mm = +m[1], dd = +m[2], yy = +m[3];
    if (mm > 12 && dd <= 12) { var t = mm; mm = dd; dd = t; }
    var d = new Date(yy, mm - 1, dd);
    return isNaN(d.getTime()) ? null : d;
}
function dxFmtDate(d) {
    var MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return d ? (MO[d.getMonth()] + ' ' + d.getFullYear()) : '';
}
// Driver age in days, measured against the dxdiag report date (falls back to now); null if no date.
function dxDriverAge(driverDate, refDate) {
    if (!driverDate) { return null; }
    var ref = refDate || new Date();
    var days = Math.round((ref.getTime() - driverDate.getTime()) / 86400000);
    return days < 0 ? 0 : days;
}
// Human-readable age. `withOld` appends " old" for the primary/standalone reading; omit it for the
// "(... at time of report)" parenthetical, which reads better as a bare duration.
function dxAgeText(days, withOld) {
    if (days == null) { return ''; }
    if (days < 45) { return withOld ? 'recent' : 'new'; }
    var s;
    if (days < 365) { s = Math.round(days / 30) + ' mo'; }
    else { var yr = days / 365; s = (yr >= 2 ? Math.round(yr) : Math.round(yr * 10) / 10) + ' yr'; }
    return withOld ? (s + ' old') : s;
}

// NVIDIA's internal WDDM version 32.0.15.8157 -> public "581.57" (last 5 digits of the concatenated tail).
function dxNvidiaDriver(ver) {
    var d = ver.replace(/\./g, '');
    if (d.length < 5) { return null; }
    var t = d.slice(-5);
    return t.slice(0, 3) + '.' + t.slice(3);
}
// Display devices -> [{ name, version, driverDate }]. dxdiag repeats a card once per attached monitor, so dedupe.
function dxGpus(text) {
    var out = [], seen = {}, start = text.indexOf('Display Devices');
    if (start < 0) { return out; }
    var blocks = text.substring(start).split(/Card name:[ \t]*/).slice(1);
    blocks.forEach(function (b) {
        var name = ((b.match(/^([^\r\n]+)/) || [])[1] || '').trim();
        if (!name) { return; }
        var vm = b.match(/Driver Version:[ \t]*([\d.]+)/), ver = vm ? vm[1] : '';
        if (/nvidia|geforce|gtx|rtx|quadro|titan/i.test(name) && ver) { ver = dxNvidiaDriver(ver) || ver; }
        var dm = b.match(/Driver Date\/Size:[ \t]*([^,\r\n]+),/);
        var hg = b.match(/Hybrid Graphics GPU:[ \t]*([^\r\n]+)/);         // Discrete / Integrated / Not Supported
        var role = hg ? hg[1].trim() : '';
        var key = name + '|' + ver;
        if (seen[key]) { return; }
        seen[key] = 1;
        out.push({ name: name, version: ver, driverDate: dm ? dxParseDate(dm[1]) : null, role: role });
    });
    return out;
}

// Build the dxdiag Quick-Info summary and drop it into #dxdiag.
function renderDxdiag(text) {
    var COL = { crit: '#ff8f8f', warn: '#ffd479', ok: '#7fdca4' };
    var reportDate = dxParseDate(dxFirst(text, 'Time of this report'));
    var html = '';

    var eve = [], kernel = [], app = [];
    parseWER(text).forEach(function (e) {
        var k = dxWerKind(e);
        (k === 'eve' ? eve : k === 'kernel' ? kernel : app).push(e);
    });

    // EVE client crashes - the headline. APPCRASH P4 = faulting module, P7 = exception code.
    if (eve.length) {
        html += '<div style="font-weight:700; color:' + COL.crit + '; margin:2px 0 4px;">&#9888; ' + eve.length +
            ' EVE client crash' + (eve.length === 1 ? '' : 'es') + ' (exefile.exe)</div>' +
            '<table style="border-collapse:collapse; font-size:12px; line-height:1.5; margin-bottom:8px;">';
        eve.forEach(function (e) {
            var mod = e.p.P4 || '', exc = dxExceptionName(e.p.P7) || e.p.P7 || '';
            var detail = [exc, mod].filter(Boolean).map(reqEscape).join(' in ');
            html += '<tr><td style="padding:0 8px 0 0; color:#9aa6b2; vertical-align:top; white-space:nowrap;">' +
                reqEscape(e.name) + '</td><td style="padding:0; color:#e6e6e6;">' + (detail || '&ndash;') + '</td></tr>';
        });
        html += '</table>';
    }

    // Kernel crashes (BSOD / live dumps), grouped by decoded bugcheck name.
    if (kernel.length) {
        var counts = {}, whea = false;
        kernel.forEach(function (e) {
            var label = /livekernel/i.test(e.name)
                ? ('LiveKernelEvent 0x' + (parseInt(e.p.P1, 16) || 0).toString(16).toUpperCase())
                : (dxBugcheckName(e.p.P1) || e.name);
            counts[label] = (counts[label] || 0) + 1;
            if (/WHEA/i.test(label)) { whea = true; }
        });
        var list = Object.keys(counts).map(function (k) { return counts[k] > 1 ? (counts[k] + '× ' + k) : k; });
        html += '<div style="font-weight:700; color:' + COL.crit + '; margin:2px 0 4px;">&#9888; ' + kernel.length +
            ' system crash' + (kernel.length === 1 ? '' : 'es') + ' in history</div>' +
            '<div style="font-size:12px; color:#e6e6e6; margin-bottom:' + (whea ? '2px' : '8px') + ';">' +
            reqEscape(list.join(', ')) + '</div>';
        if (whea) {
            html += '<div style="font-size:11px; color:' + COL.warn + '; margin-bottom:8px;">WHEA = a hardware ' +
                'error (CPU / RAM / bus) - strongly points at unstable hardware, not EVE.</div>';
        }
    }

    if (app.length) {
        html += '<div style="font-size:11px; color:#9aa6b2; margin-bottom:8px;">+ ' + app.length +
            ' other app crash' + (app.length === 1 ? '' : 'es') + ' in history</div>';
    }
    if (!eve.length && !kernel.length) {
        html += '<div style="font-size:12px; color:' + COL.ok + '; margin-bottom:8px;">&#10003; No crashes in WER history.</div>';
    }

    // dxdiag's own Direct3D probe crash.
    if (/Crashed in Direct3D/i.test(text)) {
        html += '<div style="font-size:12px; color:' + COL.warn + '; margin-bottom:8px;">&#9888; dxdiag itself ' +
            'crashed probing Direct3D - possible GPU / driver trouble.</div>';
    }

    // GPU(s): driver DATE + age (recency), version as fallback. Warn (amber) when the driver is over a year old.
    var gpus = dxGpus(text);
    if (gpus.length) {
        html += '<div style="font-size:12px; line-height:1.6;">';
        gpus.forEach(function (g) {
            var meta = [], old = false;
            // With more than one GPU, tag which is the discrete card (what EVE actually renders on) vs the iGPU.
            var tag = (gpus.length > 1 && /discrete|integrated/i.test(g.role))
                ? ' <span style="font-size:9px; text-transform:uppercase; letter-spacing:.04em; color:#9aa6b2;">' +
                  reqEscape(g.role) + '</span>' : '';
            if (g.version) { meta.push('drv ' + reqEscape(g.version)); }
            if (g.driverDate) {
                // Age from NOW (when the Bug Hunter reads it) is the headline; the age AT REPORT time is added in
                // parens only when it rounds differently - an old report makes a fixed "Nov 2025" read very
                // differently from how fresh the driver was when the bug was actually filed.
                var daysNow = dxDriverAge(g.driverDate, new Date());
                old = daysNow != null && daysNow > 365;
                var ageStr = dxAgeText(daysNow, true);
                if (reportDate) {
                    var repShort = dxAgeText(dxDriverAge(g.driverDate, reportDate), false);
                    if (repShort && repShort !== dxAgeText(daysNow, false)) {
                        ageStr += ' (' + repShort + ' at time of report)';
                    }
                }
                meta.push(dxFmtDate(g.driverDate) + (ageStr ? ' - ' + ageStr : ''));
            }
            html += '<div><b style="color:#e6e6e6;">' + reqEscape(g.name) + '</b>' + tag + (meta.length
                ? ' <span style="color:' + (old ? COL.warn : '#9aa6b2') + ';">' + meta.join(' · ') + '</span>' : '') +
                '</div>';
        });
        html += '</div>';
    }

    // System context line.
    var sys = [dxFirst(text, 'Operating System'), dxFirst(text, 'Processor'), dxFirst(text, 'Memory')]
        .filter(Boolean).map(reqEscape).join(' · ');
    if (sys) { html += '<div style="font-size:11px; color:#9aa6b2; margin-top:8px;">' + sys + '</div>'; }

    $('#dxdiag').html(html || 'Could not read dxdiag.');
}

// Floating Div for the dxdiag.txt file: the triage summary overlay (crash history / GPU driver recency / system).
var dxdiagHtml = `
<style>
`+ css +`
</style>
<div class="floating-div">
  <div><h2>Quick Info:</h2></div>
  <div id="dxdiag"></div>
</div>
`


/* =========================================================================================
 * Similar Defects feature (Phase 1: local DB + sync + BM25 keyword ranking + suggestions UI)
 *
 * Builds a local IndexedDB cache of all issues in the EDR and EO projects, and on a bug report
 * (EBR) page shows a floating panel of the most relevant existing defects. Phase 1 ranks by BM25
 * keyword similarity (fully local, no model); a later phase swaps in local semantic embeddings,
 * which is why records already reserve `embedding` / `embeddingModelVersion` fields.
 *
 * Everything lives under the JiTA namespace to avoid polluting globals. Plain var/function +
 * Promises + jQuery, matching the rest of this file. Jira REST calls are same-origin and rely on
 * the browser session cookie (no auth header / no GM_xmlhttpRequest needed), exactly like the
 * existing Translate / Convert-to-Defect calls.
 * ========================================================================================= */
var JiTA = {
    HOST: 'https://fenriscreations.atlassian.net',
    SCOPE: 'project in (EDR, EO, PLAT)',           // defect dataset (crawled + embedded); shown as similar-defect candidates on EBR pages
    EBR_SCOPE: 'project = EBR AND statusCategory != Done',  // open bug reports, for the EDR "matching reports" view
    // "EO - GameMasters" team id (Team field = customfield_10001). Bug reports assigned to the GM team are being
    // handled BY the GMs, so they're excluded from the "matching bug reports" view (see JiTA.rank EBR indexes).
    GM_TEAM_ID: 'ef4edd53-c099-4431-82af-9b4bd717cb88-38',
    FIELDS: ['summary', 'description', 'status', 'resolution', 'resolutiondate', 'created', 'components', 'updated', 'project', 'customfield_10001'],  // customfield_10001 = Team
    DB_NAME: 'EJF_SimilarDefects',   // legacy IndexedDB name - renamed identifiers to JiTA but kept this value so existing users keep their synced defect DB
    DB_VERSION: 1,
    PAGE_SIZE: 100,
    PAGE_DELAY_MS: 250,                            // polite gap between search pages
    NEAR_LIMIT_DELAY_MS: 3000,                     // back off harder when the rate-limit budget is low
    MAX_RETRIES: 5,
    // How many related issues the panel lists (similar defects / matching bug reports). User-configurable
    // from the settings menu, persisted in the GM flag 'sdTopN'; default 8, clamped 1..30 (kept below
    // JiTA.rank.CAND so the fusion candidate pool is never the limiting factor). Read live at query time,
    // so changing it from the menu re-renders with the new count without a reload.
    TOP_N: (function () {
        var v = parseInt(gmGet('sdTopN', 8), 10);
        if (!isNaN(v) && v >= 1 && v <= 30) { return v; }
        return 8;
    })(),
    MODEL_VERSION: 'gte-small-v3',                  // embedding model tag; bump to force a full re-embed
                                                    // (v1 = NaN from fp16; v2 = fp32; v3 = boilerplate-stripped text)
    DATA_VERSION: 3                                 // stored-record SCHEMA version. Bump whenever a sync change
                                                    // adds/changes a FIELD on stored records - OR widens the crawl
                                                    // SCOPE - that a plain incremental catch-up can't backfill (it
                                                    // only re-fetches CHANGED issues, so old rows / newly-in-scope
                                                    // projects are missed). On load JiTA.migrate auto-re-fetches
                                                    // any dataset stamped below this. (v1 = added the `created`
                                                    // field; v2 = added PLAT to SCOPE -> full refetch backfills
                                                    // existing PLAT defects; v3 = added the `team` field
                                                    // (customfield_10001) so GM-team bug reports can be excluded.)
};


/* ---- log signatures (Feature D): auto-mined exception fingerprints from defects ----
 * EVE defect descriptions paste exception dumps. Matching on the one-line "Formatted exception info:" message
 * alone is too weak: many UNRELATED defects share a generic message (e.g. "TypeNotFoundException: 'key not
 * found'"), so a log line was being attributed to the wrong defect. What actually identifies an exception is
 * its STACK, so we fingerprint each exception block by a normalized stack signature: the chain of
 * file:function frames with line numbers dropped, so it still matches across client builds. (EVE also emits a
 * "Stackhash: <n>", but that value is per-user / per-exception - NOT stable across users - so it is useless
 * for matching and is no longer read.) We mine the signature per exception block from every defect; defects
 * that share a signature form a CLUSTER, which drives both directions: flagging known exceptions in a log
 * (log -> defect) AND grouping duplicate defects (the "Same exception" / "Exception clusters" views). The
 * index rebuilds whenever the defect DB changes.
 */
JiTA.logsig = {
    // _index: {
    //   sigMap:    { sig -> { sig, label, members:[{key,status,resolution,resolutiondate,created}] } },  // EXACT (full chain)
    //   keyToSigs: { key -> [sig,...] },
    //   crashMap:  { crashSig -> { crashSig, label, members:[...] } },  // LOOSE (crash site = message + innermost frames)
    //   keyToCrash:{ key -> [crashSig,...] }
    // }
    _index: null,
    _building: null,
    _dirty: true,
    MIN_FRAMES: 2,        // need at least this many stack frames to trust a stack signature (else too generic)
    CRASH_FRAMES: 2,      // crash-site signature uses only the INNERMOST this-many frames (the throw location),
                          // so the same bug reached via a different call path still matches as "possibly related"

    // Split a blob of text into individual EXCEPTION blocks. Stored descriptions have newlines collapsed to
    // spaces, but "EXCEPTION #" / "EXCEPTION END" / "Stackhash:" all survive as substrings, so this works on
    // both the (collapsed) defect description and a (re-joined) log block.
    _splitBlocks: function (text) {
        var blocks = [], re = /EXCEPTION #[\s\S]*?(?=EXCEPTION #|$)/gi, m;
        while ((m = re.exec(text))) { blocks.push(m[0]); if (re.lastIndex === m.index) { re.lastIndex++; } }
        return blocks.length ? blocks : [text || ''];
    },

    // Fingerprint one exception block -> { sig, msg }. `sig` is the lowercased "<message>|<frame>>...>frame>"
    // built from the file:function chain (line numbers dropped for cross-build robustness), or null when there
    // aren't enough frames to be distinctive; `msg` is the human "Formatted exception info" text (used as a
    // panel / cluster label). (The "Stackhash: <n>" literal is per-user, so it is no longer extracted.)
    _fingerprint: function (text) {
        text = text || '';
        // Strip the EVE log-line prefix ("HH:MM:SS<TAB>facility<TAB>type<TAB>") that a DEFECT DESCRIPTION
        // carries when someone pastes the RAW log into it. Without this, the blank lines between "Formatted
        // exception info:" and "Common path prefix" leak their "timestamp facility type" prefix into the
        // captured message, so the defect's signature (e.g. "keyerror: 2 22:10:48 client::general error|…")
        // no longer matches the SAME exception seen in the parsed log, whose rows are message-column only
        // ("keyerror: 2|…"). Stripping here normalizes both sides. (Log-side block text has no such prefix,
        // so this is a no-op there.)
        text = text.replace(/^[ \t]*\d{1,2}:\d{2}:\d{2}\t[^\t\n]*\t[^\t\n]*\t/gm, '');
        var msg = '', mm = /Formatted exception info\s*:?\s*([\s\S]*?)(?:\bCommon path prefix\b|\bCaught at\b|\bThrown at\b|\bReported from\b|\bThread Locals\b|\bStackhash\b|\bEXCEPTION END\b|$)/i.exec(text);
        if (mm) { msg = (mm[1] || '').replace(/\s+/g, ' ').trim(); }
        var frames = [], fre = /([A-Za-z0-9_.\/\\-]+\.py)\((\d+)\)\s+([A-Za-z0-9_<>]+)/g, fm;
        while ((fm = fre.exec(text))) {
            frames.push(fm[1].replace(/^.*[\/\\]/, '') + ':' + fm[3]);   // basename:function (no line number)
        }
        // The SAME bug at the SAME stack site is constantly reported with DIFFERENT volatile numbers baked into
        // the exception MESSAGE, which would otherwise make every report's signature unique even though the
        // frame chain is identical. We normalize ONLY the clearly-incidental numbers to '#' for the SIGNATURE
        // (the RAW msg is kept for the human-readable label), and DELIBERATELY leave a bare scalar argument
        // alone so it still distinguishes otherwise-identical exceptions:
        //   - 0x hex addresses (object repr ids)                       e.g. "at 0x254ffd..."   -> "at 0x#"
        //   - python longs (`<digits>L`) - always an id               "KeyError: 90022...218L" -> "KeyError: #"
        //   - runs of 4+ digits - long item/type/char ids             "...(.., 1677)" -> "...(.., #)"
        //   - numbers INSIDE a tuple/list/dict payload (bracket- or    "(12, 1677)" / "(13, 1)" -> "(#, #)"
        //     comma-adjacent), since those are per-report args
        // The bare-scalar exception, though, is preserved: "KeyError: 2" and "KeyError: 188" stay DISTINCT
        // (1-3 digits, not bracketed), because for a KeyError/ValueError the scalar key IS the meaningful part.
        // Identifiers/words (UserError, MISMATCH_COST, ...) are never touched, and the stack still gates every
        // match on top of this.
        var nmsg = msg
            .replace(/0x[0-9a-fA-F]+/g, '0x#')        // memory addresses (e.g. object repr ids)
            .replace(/\b\d+L\b/g, '#')                 // python long literals - always an id (item/type/char/...)
            .replace(/([(\[{,]\s*)\d+/g, '$1#')        // tuple/list/dict element (leading edge: after ( [ { or ,)
            .replace(/\d+(\s*[)\]},])/g, '#$1')        // ...and trailing edge (before ) ] } or ,)
            .replace(/\b\d{4,}\b/g, '#');              // other long numeric ids (a bare scalar < 4 digits survives)
        var sig = (frames.length >= JiTA.logsig.MIN_FRAMES)
            ? (nmsg + '|' + frames.join('>')).toLowerCase()
            : null;
        // Crash-site signature: message + only the INNERMOST CRASH_FRAMES frames (where the exception was
        // actually thrown). Two defects that crash at the SAME place with the SAME message but were reached by
        // a DIFFERENT call path share this even though their full `sig` differs - it drives the looser
        // "possibly related" hint (never an exact cluster). Same null condition as `sig` (needs >= MIN_FRAMES).
        var crashSig = (frames.length >= JiTA.logsig.MIN_FRAMES)
            ? (nmsg + '|' + frames.slice(-JiTA.logsig.CRASH_FRAMES).join('>')).toLowerCase()
            : null;
        return { sig: sig, crashSig: crashSig, msg: msg };
    },

    // Build (and cache) the signature index from every stored defect. Every defect exhibiting a signature is
    // appended to that signature's cluster (NOT deduped to the first - the whole point is to group them);
    // a defect can paste several exception dumps, so we fingerprint each block. Resolved defects are kept so
    // a cluster can show "already fixed in EDR-x" / regression. keyToSigs lets a single issue find its
    // cluster(s) cheaply. The (key, sig) pair is deduped so one defect counts once per signature.
    ensure: function () {
        if (JiTA.logsig._index && !JiTA.logsig._dirty) { return Promise.resolve(JiTA.logsig._index); }
        if (JiTA.logsig._building) { return JiTA.logsig._building; }
        JiTA.logsig._building = JiTA.db.allDefects().then(function (recs) {
            var sigMap = {}, keyToSigs = {}, crashMap = {}, keyToCrash = {}, nSig = 0;
            for (var i = 0; i < recs.length; i++) {
                if (recs[i].project === 'EBR') { continue; }   // mine exception signatures from DEFECTS only, not bug reports
                var desc = recs[i].description;
                if (!desc || desc.indexOf('EXCEPTION #') === -1) { continue; }
                var key = recs[i].key;
                // One member record per defect, shared (by reference) across whatever clusters it lands in.
                var member = { key: key, status: recs[i].status || '', resolution: recs[i].resolution || null, resolutiondate: recs[i].resolutiondate || null, created: recs[i].created || null };
                var blocks = JiTA.logsig._splitBlocks(desc);
                for (var b = 0; b < blocks.length; b++) {
                    var fp = JiTA.logsig._fingerprint(blocks[b]);
                    if (!fp.sig) { continue; }
                    // EXACT cluster: keyed on the full stack-frame chain (precise).
                    var c = sigMap[fp.sig];
                    if (!c) { c = sigMap[fp.sig] = { sig: fp.sig, label: fp.msg || '', members: [] }; nSig++; }
                    if (!c.label && fp.msg) { c.label = fp.msg; }
                    if (!keyToSigs[key]) { keyToSigs[key] = []; }
                    if (keyToSigs[key].indexOf(fp.sig) === -1) {   // first time THIS defect shows THIS signature
                        keyToSigs[key].push(fp.sig);
                        c.members.push(member);
                    }
                    // CRASH-SITE cluster: keyed on message + innermost frames only, so the same bug reached via
                    // a different call path groups here (drives the looser "possibly related" relation).
                    if (fp.crashSig) {
                        var cc = crashMap[fp.crashSig];
                        if (!cc) { cc = crashMap[fp.crashSig] = { crashSig: fp.crashSig, label: fp.msg || '', members: [] }; }
                        if (!cc.label && fp.msg) { cc.label = fp.msg; }
                        if (!keyToCrash[key]) { keyToCrash[key] = []; }
                        if (keyToCrash[key].indexOf(fp.crashSig) === -1) {
                            keyToCrash[key].push(fp.crashSig);
                            cc.members.push(member);
                        }
                    }
                }
            }
            // Order each cluster's members NEWEST-FIRST (by created date), so members[0] - the canonical
            // defect used as the main/log-badge entry and the head of every "related"/sibling list - is the
            // most recently created one, and the rest read newest->oldest below it.
            function memberSort(a, b) {
                var ac = a.created || '', bc = b.created || '';
                if (ac !== bc) { return ac < bc ? 1 : -1; }   // later ISO timestamp (newer) first
                return a.key < b.key ? -1 : 1;                 // stable tiebreak when dates are equal/missing
            }
            Object.keys(sigMap).forEach(function (s) { sigMap[s].members.sort(memberSort); });
            Object.keys(crashMap).forEach(function (s) { crashMap[s].members.sort(memberSort); });
            JiTA.logsig._index = { sigMap: sigMap, keyToSigs: keyToSigs, crashMap: crashMap, keyToCrash: keyToCrash };
            JiTA.logsig._dirty = false;
            JiTA.logsig._building = null;
            var nClusters = 0;
            Object.keys(sigMap).forEach(function (s) { if (sigMap[s].members.length >= 2) { nClusters++; } });
            console.log('[JiTA] log signatures: ' + nSig + ' stack signatures (' + nClusters + ' shared across ≥2 defects) mined from ' + recs.length + ' defects');
            return JiTA.logsig._index;
        }).catch(function (e) { JiTA.logsig._building = null; throw e; });
        return JiTA.logsig._building;
    },

    // Every OTHER defect that shares a signature with `key` (deduped across all of the key's signatures),
    // each with its status/resolution. Drives the inline "Same exception" section on a defect. [] when none.
    siblingsForKey: function (key) {
        return JiTA.logsig.ensure().then(function (idx) {
            var out = [], seen = {};
            seen[key] = true;
            var sigs = (idx && idx.keyToSigs && idx.keyToSigs[key]) || [];
            for (var s = 0; s < sigs.length; s++) {
                var c = idx.sigMap[sigs[s]];
                if (!c) { continue; }
                for (var m = 0; m < c.members.length; m++) {
                    var mem = c.members[m];
                    if (seen[mem.key]) { continue; }
                    seen[mem.key] = true;
                    out.push(mem);
                }
            }
            return out;
        });
    },

    // Every defect that shares this key's CRASH SITE (message + innermost frames) but is NOT already an exact
    // sibling - i.e. the SAME bug reached via a DIFFERENT call path. Looser than siblingsForKey; drives the
    // "Possibly related" hint. [] when none.
    relatedForKey: function (key) {
        return JiTA.logsig.ensure().then(function (idx) {
            if (!idx) { return []; }
            var exclude = {};
            exclude[key] = true;
            var sigs = (idx.keyToSigs && idx.keyToSigs[key]) || [];
            for (var s = 0; s < sigs.length; s++) {   // exclude exact siblings (already shown under "Same exception")
                var sc = idx.sigMap[sigs[s]];
                if (sc) { for (var e = 0; e < sc.members.length; e++) { exclude[sc.members[e].key] = true; } }
            }
            var out = [], seen = {};
            var csigs = (idx.keyToCrash && idx.keyToCrash[key]) || [];
            for (var c = 0; c < csigs.length; c++) {
                var cc = idx.crashMap[csigs[c]];
                if (!cc) { continue; }
                for (var m = 0; m < cc.members.length; m++) {
                    var mem = cc.members[m];
                    if (exclude[mem.key] || seen[mem.key]) { continue; }
                    seen[mem.key] = true;
                    out.push(mem);
                }
            }
            return out;
        });
    },

    // All signatures shared by >=2 defects, ordered so the clusters whose NEWEST defect is most recent come
    // first (the freshly-recurring exceptions a triager most wants to see), with cluster size as the
    // tiebreaker. Drives the "Exception clusters" overview.
    clusters: function () {
        function newest(members) {
            var n = '';
            for (var i = 0; i < members.length; i++) {
                if (members[i].created && members[i].created > n) { n = members[i].created; }   // ISO strings sort chronologically
            }
            return n;
        }
        return JiTA.logsig.ensure().then(function (idx) {
            var out = [];
            if (idx && idx.sigMap) {
                Object.keys(idx.sigMap).forEach(function (sig) {
                    var c = idx.sigMap[sig];
                    if (c.members.length >= 2) { out.push({ sig: sig, label: c.label, members: c.members, newest: newest(c.members) }); }
                });
                out.sort(function (a, b) {
                    if (a.newest !== b.newest) { return a.newest < b.newest ? 1 : -1; }   // most-recent defect first
                    return b.members.length - a.members.length || (a.label < b.label ? -1 : 1);
                });
            }
            return out;
        });
    },

    // One collapsible cluster row for the overview: "<count> <signature label>" that expands to its members.
    _clusterRow: function (c) {
        var wrap = document.createElement('div');
        wrap.className = 'jita-excl-cluster';
        var headRow = document.createElement('div');
        headRow.className = 'jita-excl-head';
        var cnt = document.createElement('span');
        cnt.className = 'jita-exc-badge open';
        cnt.textContent = c.members.length;
        headRow.appendChild(cnt);
        var lbl = document.createElement('span');
        lbl.className = 'jita-excl-label';
        lbl.textContent = c.label || c.sig;
        lbl.title = c.sig;
        headRow.appendChild(lbl);
        var members = document.createElement('div');
        members.className = 'jita-exc-members';
        members.style.display = 'none';
        c.members.forEach(function (m) { members.appendChild(JiTA.logsig._memberRowEl(m)); });
        headRow.addEventListener('click', function () {
            members.style.display = (members.style.display === 'none') ? '' : 'none';
        });
        wrap.appendChild(headRow);
        wrap.appendChild(members);
        return wrap;
    },

    // The standalone "Exception clusters" overview: every signature shared by >=2 defects, newest defect
    // first, each expandable to its members. Reuses the settings-menu overlay chrome (#jita-menu-overlay / #jita-menu).
    openClustersView: function () {
        JiTA.logsig._injectClusterCss();
        var ov = JiTA.menu._openOverlay({ title: 'Exception clusters' });
        var $overlay = ov.$overlay;
        var $sect = $('<div class="jita-menu-sect"></div>').appendTo(ov.$menu);
        $('<div class="jita-menu-status">Loading clusters…</div>').appendTo($sect);
        JiTA.logsig.clusters().then(function (clusters) {
            if (!document.body.contains($overlay[0])) { return; }   // closed before the build finished
            $sect.empty();
            if (!clusters.length) {
                $('<div class="jita-menu-status">No exception is shared by 2+ defects yet. (Sync the defect DB first if you haven’t.)</div>').appendTo($sect);
                return;
            }
            $('<div class="jita-menu-status"></div>')
                .text(clusters.length + ' exception' + (clusters.length === 1 ? '' : 's') + ' shared by 2+ defects · newest first')
                .appendTo($sect);
            clusters.forEach(function (c) { $sect.append(JiTA.logsig._clusterRow(c)); });
        }, function () {
            if (!document.body.contains($overlay[0])) { return; }
            $sect.empty();
            $('<div class="jita-menu-status">Could not build clusters.</div>').appendTo($sect);
        });
    },

    // After the main log parser renders, group rows into EXCEPTION blocks, fingerprint each, and match it to
    // a defect by stack signature. The matched defect is flagged on the block's first (EXCEPTION #) row -
    // amber accent + tooltip + [EDR-x] badge - and counted for the panel, which also lists the rest of that
    // defect's cluster. Async (the index is built from IndexedDB); safe to call right after ParseLogs - it
    // patches the already-rendered rows.
    applyToTable: function () {
        return JiTA.logsig.ensure().then(function (idx) {
            if (!idx) { return; }
            var rows = document.querySelectorAll('#tableContent tbody tr');
            var found = {};   // defect -> { defect, count, rows:[anchor tr,...], raw (label), cluster:[sibling members] }
            function cellText(tr) { var c = tr.lastElementChild; return c ? (c.textContent || '') : ''; }
            // Every other defect that shares ANY of this defect's signatures (computed from idx, so it is
            // available on re-passes that only know the stored defect key, not the original signature).
            function siblings(defect) {
                var out = [], seen = {};
                seen[defect] = true;
                var sigs = (idx.keyToSigs && idx.keyToSigs[defect]) || [];
                for (var s = 0; s < sigs.length; s++) {
                    var c = idx.sigMap[sigs[s]];
                    if (!c) { continue; }
                    for (var m = 0; m < c.members.length; m++) {
                        if (seen[c.members[m].key]) { continue; }
                        seen[c.members[m].key] = true;
                        out.push(c.members[m]);
                    }
                }
                return out;
            }
            // Defects that share this defect's CRASH SITE but aren't exact siblings (same bug, different path).
            function crashPeers(defect) {
                var out = [], seen = {};
                seen[defect] = true;
                var cs = (idx.keyToCrash && idx.keyToCrash[defect]) || [];
                for (var s = 0; s < cs.length; s++) {
                    var cc = idx.crashMap[cs[s]];
                    if (!cc) { continue; }
                    for (var m = 0; m < cc.members.length; m++) {
                        if (seen[cc.members[m].key]) { continue; }
                        seen[cc.members[m].key] = true;
                        out.push(cc.members[m]);
                    }
                }
                return out;
            }
            // The "+N related" list for a found defect: exact-path siblings first, then (tagged) crash-site peers.
            function clusterFor(defect) {
                var exact = siblings(defect), seen = {};
                for (var i2 = 0; i2 < exact.length; i2++) { seen[exact[i2].key] = true; }
                var rel = [], peers = crashPeers(defect);
                for (var p = 0; p < peers.length; p++) {
                    if (seen[peers[p].key]) { continue; }
                    var o = {}, src = peers[p];
                    for (var k in src) { if (Object.prototype.hasOwnProperty.call(src, k)) { o[k] = src[k]; } }
                    o.related = true;   // "~ similar" (same crash site, different call path)
                    rel.push(o);
                }
                return exact.concat(rel);
            }
            function tally(defect, tr, label, loose) {
                if (!found[defect]) { found[defect] = { defect: defect, count: 0, rows: [], raw: label || '', loose: !!loose, cluster: clusterFor(defect) }; }
                found[defect].count++;
                found[defect].rows.push(tr);
                if (!found[defect].raw && label) { found[defect].raw = label; }
                if (!loose) { found[defect].loose = false; }   // any exact hit upgrades the entry from "possibly related"
            }
            function markAnchor(tr, defect, loose) {
                var cell = tr.lastElementChild;
                tr.className += loose ? ' sig-hit-loose' : ' sig-hit';
                if (cell) {
                    cell.title = (loose ? 'Possibly related (same crash site) · ' : 'Known exception · ') + defect;
                    var col = loose ? '#9aa6b2' : '#4c9aff';
                    cell.innerHTML = '<a href="/browse/' + defect + '" target="_blank" style="color:' + col + ';font-weight:700;margin-right:6px;">[' + (loose ? '~' : '') + defect + ']</a>' + cell.innerHTML;
                }
            }
            var i = 0;
            while (i < rows.length) {
                var tr = rows[i];
                var marked = tr.getAttribute('data-jita-sig');
                if (marked) {                                     // already processed in a previous pass
                    if (marked !== '0') {                          // ...re-count anchors for the panel
                        var lk = marked.charAt(0) === '~';        // '~' prefix = loose (crash-site) match
                        tally(lk ? marked.slice(1) : marked, tr, null, lk);
                    }
                    i++;
                    continue;
                }
                if (cellText(tr).indexOf('EXCEPTION #') === -1) { tr.setAttribute('data-jita-sig', '0'); i++; continue; }
                // Gather the whole exception block: rows until EXCEPTION END (inclusive) or the next EXCEPTION #.
                var blockRows = [tr], blockText = cellText(tr), j = i + 1;
                for (; j < rows.length; j++) {
                    var t2 = cellText(rows[j]);
                    if (t2.indexOf('EXCEPTION #') !== -1) { break; }
                    blockRows.push(rows[j]);
                    blockText += '\n' + t2;
                    if (t2.indexOf('EXCEPTION END') !== -1) { j++; break; }
                }
                var fp = JiTA.logsig._fingerprint(blockText);
                var defect = (fp.sig && idx.sigMap[fp.sig]) ? idx.sigMap[fp.sig].members[0].key : null;
                var loose = false;
                if (!defect && fp.crashSig && idx.crashMap[fp.crashSig]) {   // no exact hit -> same-crash-site fallback
                    defect = idx.crashMap[fp.crashSig].members[0].key;
                    loose = true;
                }
                // Mark every block row as scanned; only the anchor (first row) carries the defect key (a '~'
                // prefix flags a loose crash-site match so a re-pass keeps the right styling).
                for (var b = 0; b < blockRows.length; b++) {
                    if (!blockRows[b].getAttribute('data-jita-sig')) {
                        blockRows[b].setAttribute('data-jita-sig', (b === 0 && defect) ? ((loose ? '~' : '') + defect) : '0');
                    }
                }
                if (defect) { markAnchor(tr, defect, loose); tally(defect, tr, fp.msg, loose); }
                i = j;
            }
            JiTA.logsig.renderPanel(found);
        }).catch(function (e) { console.log('[JiTA] log signature apply skipped:', e && e.message || e); });
    },

    // Re-run the log->defect match against the CURRENT (possibly just-synced) signature index. Clears the
    // per-row data-jita-sig scan cache first so EVERY exception block is re-fingerprinted - otherwise rows
    // marked '0' (no match) on the first pass would never re-match a defect that has since been synced in.
    // No-op when no parsed log is open. Called after a sync completes (JiTA.sched.markSynced).
    rematch: function () {
        if (!document.getElementById('tableContent')) { return; }   // no parsed log open
        var rows = document.querySelectorAll('#tableContent tbody tr');
        for (var i = 0; i < rows.length; i++) { rows[i].removeAttribute('data-jita-sig'); }
        JiTA.logsig.applyToTable();
    },

    // Match a RAW logs.txt (fetched straight from an EBR's attachments, WITHOUT opening it in the parser)
    // against the mined fingerprints. The raw log is tab-separated, one record per line:
    // Time<TAB>Facility<TAB>Type<TAB>Message. We MUST segment it the same way applyToTable segments the
    // rendered rows, or the fingerprints won't match: (1) work on the MESSAGE column only - otherwise the
    // timestamps/facilities and every interleaved non-exception log line pollute the stack-frame chain;
    // (2) bound each exception block at EXCEPTION END (or the next EXCEPTION #) - otherwise one block would
    // swallow the whole rest of the log (hundreds of unrelated `file.py(NN) func` lines) and the stack
    // signature would never match the clean one in the index. Resolves to { defect -> { defect, count, msg } }.
    matchText: function (text) {
        return JiTA.logsig.ensure().then(function (idx) {
            var found = {};
            if (!idx || !text) { return found; }
            // Pull the message column out of every record (everything after the 3rd tab); keep prefix-less
            // continuation lines as-is. This mirrors what cellText() reads from each rendered row.
            var lines = text.replace(/\r/g, '').split('\n'), messages = [];
            for (var li = 0; li < lines.length; li++) {
                var parts = lines[li].split('\t');
                messages.push(parts.length >= 4 ? parts.slice(3).join('\t') : lines[li]);
            }
            function tallyBlock(blockText) {
                var fp = JiTA.logsig._fingerprint(blockText);
                var defect = (fp.sig && idx.sigMap[fp.sig]) ? idx.sigMap[fp.sig].members[0].key : null;
                var loose = false;
                if (!defect && fp.crashSig && idx.crashMap[fp.crashSig]) {   // no exact hit -> same-crash-site fallback
                    defect = idx.crashMap[fp.crashSig].members[0].key;
                    loose = true;
                }
                if (!defect) { return; }
                if (!found[defect]) { found[defect] = { defect: defect, count: 0, msg: fp.msg || '', loose: loose }; }
                found[defect].count++;
                if (!loose) { found[defect].loose = false; }   // an exact hit upgrades it from "possibly related"
                if (!found[defect].msg && fp.msg) { found[defect].msg = fp.msg; }
            }
            // Group message lines into exception blocks exactly like applyToTable: EXCEPTION # starts a block,
            // EXCEPTION END (inclusive) or the next EXCEPTION # ends it.
            var i = 0;
            while (i < messages.length) {
                if (messages[i].indexOf('EXCEPTION #') === -1) { i++; continue; }
                var blockText = messages[i], j = i + 1;
                for (; j < messages.length; j++) {
                    if (messages[j].indexOf('EXCEPTION #') !== -1) { break; }
                    blockText += '\n' + messages[j];
                    if (messages[j].indexOf('EXCEPTION END') !== -1) { j++; break; }
                }
                tallyBlock(blockText);
                i = j;
            }
            return found;
        });
    },

    /* ---- floating "Defects in log" panel ----
     * Lists every defect whose known exception signature appears in the open log file, with an occurrence
     * count. Clicking an entry scrolls the log to an occurrence (cycling through them on repeat clicks) and
     * flashes the row. Mirrors the Similar Defects panel feel: draggable, with position + collapse state
     * persisted in GM storage. The row highlight + [EDR-x] badge are kept so the scrolled-to row stands out.
     */
    POS_KEY: 'logMatchPanelPos',
    COLLAPSE_KEY: 'logMatchPanelCollapsed',
    _cssInjected: false,
    _panelIdx: {},        // defect -> next occurrence index to scroll to (for cycling)

    _injectCss: function () {
        if (JiTA.logsig._cssInjected) { return; }
        GM_addStyle('\
#jita-logmatch-panel { position: fixed; top: 70px; right: 18px; width: 300px; max-height: 70vh; z-index: 9000;\
  background: #1D2125; color: #e6e6e6; border: 1px solid #3a434d; border-radius: 6px; box-shadow: 0 4px 18px rgba(0,0,0,.45);\
  font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; font-size: 12px; display: flex; flex-direction: column; overflow: hidden; }\
#jita-logmatch-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: #282d33; cursor: move; user-select: none; }\
#jita-logmatch-panel.jita-logmatch-dragging { opacity: .92; }\
#jita-logmatch-title { font-weight: 700; flex: 1; }\
#jita-logmatch-collapse { cursor: pointer; padding: 0 4px; font-weight: 700; }\
#jita-logmatch-list { list-style: none; margin: 0; padding: 0; overflow-y: auto; }\
#jita-logmatch-panel.collapsed #jita-logmatch-list { display: none; }\
#jita-logmatch-panel.jita-logmatch-up { flex-direction: column-reverse; }\
.jita-logmatch-item { padding: 7px 10px; border-bottom: 1px solid #2c333a; cursor: pointer; }\
.jita-logmatch-item:hover { background: #22272b; }\
.jita-logmatch-item a { color: #4c9aff; font-weight: 700; text-decoration: none; }\
.jita-logmatch-item a:hover { text-decoration: underline; }\
.jita-logmatch-count { float: right; background: #3a434d; color: #cfd6dd; border-radius: 8px; padding: 0 7px; font-size: 10px; font-weight: 700; }\
.jita-logmatch-sig { margin-top: 3px; color: #9aa6b2; font-family: "Courier New",monospace; font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\
.jita-logmatch-flash > td { animation: jitaLogFlash 1.5s ease-out; }\
@keyframes jitaLogFlash { 0%, 25% { background-color: rgba(255,181,71,.6); } 100% { background-color: transparent; } }');
        JiTA.logsig._cssInjected = true;
    },

    // Shared styling for cluster member rows + status badges, reused by all three surfaces (the log panel's
    // "+N related" expander, the inline "Same exception" section, and the "Exception clusters" overview).
    _clusterCssInjected: false,
    _injectClusterCss: function () {
        if (JiTA.logsig._clusterCssInjected) { return; }
        GM_addStyle('\
.jita-exc-related-toggle { display: inline-block; margin-top: 5px; color: #9aa6b2; font-size: 11px; cursor: pointer; user-select: none; }\
.jita-exc-related-toggle:hover { color: #cfd6dd; }\
.jita-exc-members { list-style: none; margin: 4px 0 0; padding: 4px 0 0 8px; border-left: 2px solid #2c333a; }\
.jita-exc-member { padding: 3px 0; display: flex; align-items: center; gap: 7px; }\
.jita-exc-member a { color: #4c9aff; text-decoration: none; font-weight: 700; }\
.jita-exc-member a:hover { text-decoration: underline; }\
.jita-exc-badge { font-size: 10px; font-weight: 700; border-radius: 8px; padding: 1px 7px; white-space: nowrap; }\
.jita-exc-badge.open { background: #3a434d; color: #cfd6dd; }\
.jita-exc-badge.fixed { background: #1f3d2e; color: #7fdca4; }\
.jita-exc-badge.warn { background: #5a3a1a; color: #ffb547; }\
.jita-exc-badge.rel { background: transparent; color: #9aa6b2; border: 1px solid #3a434d; }\
.jita-excl-cluster { border-bottom: 1px solid #2c333a; padding: 7px 0; }\
.jita-excl-head { display: flex; align-items: center; gap: 8px; cursor: pointer; }\
.jita-excl-head:hover .jita-excl-label { color: #fff; }\
.jita-excl-label { flex: 1; font-family: "Courier New",monospace; font-size: 11px; color: #cfd6dd; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\
/* Inline "Same exception" section: flow the members side-by-side (wrapping) to save vertical space. */\
#jita-sd-exccluster .jita-exc-members { display: flex; flex-wrap: wrap; gap: 5px 14px; }\
#jita-sd-exccluster .jita-exc-member { padding: 2px 0; }');
        JiTA.logsig._clusterCssInjected = true;
    },

    // A status badge for a cluster member: "Fixed"/<resolution> (green) when resolved, else <status>/"Open".
    _statusBadgeEl: function (member) {
        var resolved = !!(member.resolution || member.resolutiondate);
        var badge = document.createElement('span');
        badge.className = 'jita-exc-badge ' + (resolved ? 'fixed' : 'open');
        badge.textContent = resolved ? (member.resolution || 'Fixed') : (member.status || 'Open');
        return badge;
    },

    // One cluster-member row: key link + status badge + hover preview card. `extraEl` is an optional trailing
    // element (e.g. a ⚠ regression flag). Returns a raw DOM element so both the (vanilla) log panel and the
    // (jQuery) issue/menu surfaces can use it.
    _memberRowEl: function (member, extraEl) {
        var row = document.createElement('div');
        row.className = 'jita-exc-member';
        var a = document.createElement('a');
        a.href = '/browse/' + member.key;
        a.target = '_blank';
        a.textContent = member.key;
        a.addEventListener('click', function (ev) { ev.stopPropagation(); });
        row.appendChild(a);
        row.appendChild(JiTA.logsig._statusBadgeEl(member));
        if (member.related) {   // crash-site peer (same bug, different call path) - flag it as looser
            var rel = document.createElement('span');
            rel.className = 'jita-exc-badge rel';
            rel.textContent = '~ similar';
            rel.title = 'Same crash site, reached via a different call path - possibly related';
            row.appendChild(rel);
        }
        if (extraEl) { row.appendChild(extraEl); }
        row.addEventListener('mouseenter', function () { JiTA.logsig._showDefectTip(member.key, row); });
        row.addEventListener('mouseleave', function () {
            JiTA.logsig._hoverKey = null;
            if (JiTA.ui && JiTA.ui._hideTip) { JiTA.ui._hideTip(); }
        });
        return row;
    },

    // Remove the panel once the log viewer is gone (closed / navigated away). Called from the global observer.
    updateVisibility: function () {
        var panel = document.getElementById('jita-logmatch-panel');
        if (panel && !document.getElementById('tableContent')) { panel.parentNode.removeChild(panel); }
    },

    renderPanel: function (found) {
        var keys = Object.keys(found || {});
        var existing = document.getElementById('jita-logmatch-panel');
        if (!keys.length) { if (existing) { existing.parentNode.removeChild(existing); } return; }
        JiTA.logsig._injectCss();

        // Most-frequent first, then by key for a stable order.
        keys.sort(function (a, b) { return found[b].count - found[a].count || (a < b ? -1 : 1); });

        var panel = existing;
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'jita-logmatch-panel';
            document.body.appendChild(panel);
        }
        panel.innerHTML = '';
        JiTA.logsig._panelIdx = {};

        var collapsed = false;
        collapsed = !!gmGet(JiTA.logsig.COLLAPSE_KEY, false);
        panel.className = collapsed ? 'collapsed' : '';

        var head = document.createElement('div');
        head.id = 'jita-logmatch-head';
        var title = document.createElement('span');
        title.id = 'jita-logmatch-title';
        title.textContent = 'Defects in log · ' + keys.length;
        head.appendChild(title);
        var collapse = document.createElement('span');
        collapse.id = 'jita-logmatch-collapse';
        collapse.title = 'Collapse / expand';
        collapse.textContent = collapsed ? '+' : '–';
        head.appendChild(collapse);
        panel.appendChild(head);

        var listEl = document.createElement('ul');
        listEl.id = 'jita-logmatch-list';
        panel.appendChild(listEl);

        keys.forEach(function (key) {
            var entry = found[key];
            var li = document.createElement('li');
            li.className = 'jita-logmatch-item';
            li.title = 'Click to scroll to an occurrence of ' + key + (entry.rows.length > 1 ? ' (click again for the next)' : '');

            // The "main" row content (key + count + signature). The hover preview for THIS defect is bound to
            // this wrapper - NOT the whole <li> - so moving the mouse off a cluster member row back up here
            // re-fires mouseenter and re-shows the main defect's preview (a <li> mouseenter would not, since
            // the pointer never actually left the <li>).
            var mainEl = document.createElement('div');
            mainEl.className = 'jita-logmatch-main';

            var a = document.createElement('a');
            a.href = '/browse/' + key;
            a.target = '_blank';
            a.textContent = key;
            a.addEventListener('click', function (ev) { ev.stopPropagation(); });   // open the defect, don't scroll
            mainEl.appendChild(a);

            var badge = document.createElement('span');
            badge.className = 'jita-logmatch-count';
            badge.textContent = entry.count + '×';
            mainEl.appendChild(badge);

            if (entry.loose) {   // matched only by crash site (no exact stack match) - flag it as looser
                var lt = document.createElement('span');
                lt.className = 'jita-logmatch-count';   // reuse the pill, but muted + transparent
                lt.style.background = 'transparent';
                lt.style.color = '#9aa6b2';
                lt.style.marginRight = '6px';
                lt.textContent = '~ similar';
                lt.title = 'Same crash site, reached via a different call path - possibly related';
                mainEl.appendChild(lt);
            }

            if (entry.raw) {
                var sig = document.createElement('div');
                sig.className = 'jita-logmatch-sig';
                sig.textContent = entry.raw;
                mainEl.appendChild(sig);
            }

            // Hover preview: show what the defect is about (same styled card as the Similar Defects panel).
            mainEl.addEventListener('mouseenter', function () { JiTA.logsig._showDefectTip(key, mainEl); });
            mainEl.addEventListener('mouseleave', function () {
                JiTA.logsig._hoverKey = null;
                if (JiTA.ui && JiTA.ui._hideTip) { JiTA.ui._hideTip(); }
            });
            li.appendChild(mainEl);

            // The rest of this defect's cluster - every OTHER defect that reported the same exception - behind
            // a "+N related" expander, so a known logged exception shows all its variants, not just one.
            if (entry.cluster && entry.cluster.length) {
                JiTA.logsig._injectClusterCss();
                var members = document.createElement('div');
                members.className = 'jita-exc-members';
                members.style.display = 'none';
                entry.cluster.forEach(function (m) { members.appendChild(JiTA.logsig._memberRowEl(m)); });
                var toggle = document.createElement('div');
                toggle.className = 'jita-exc-related-toggle';
                toggle.textContent = '+' + entry.cluster.length + ' related ▸';
                toggle.addEventListener('click', function (ev) {
                    ev.stopPropagation();   // don't trigger the row's scroll-to-occurrence
                    var open = members.style.display === 'none';
                    members.style.display = open ? '' : 'none';
                    toggle.textContent = '+' + entry.cluster.length + ' related ' + (open ? '▾' : '▸');
                    JiTA.logsig._fitVertical(panel);
                });
                li.appendChild(toggle);
                li.appendChild(members);
            }

            li.addEventListener('click', function () {
                var rowsArr = entry.rows;
                if (!rowsArr.length) { return; }
                var i = JiTA.logsig._panelIdx[key] || 0;
                if (i >= rowsArr.length) { i = 0; }              // wrap around
                JiTA.logsig._panelIdx[key] = i + 1;
                var target = rowsArr[i];
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                target.classList.add('jita-logmatch-flash');
                setTimeout(function () { target.classList.remove('jita-logmatch-flash'); }, 1500);
            });

            listEl.appendChild(li);
        });

        collapse.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var isCollapsed = panel.classList.toggle('collapsed');
            collapse.textContent = isCollapsed ? '+' : '–';
            gmSet(JiTA.logsig.COLLAPSE_KEY, isCollapsed);
            JiTA.logsig._fitVertical(panel);   // on expand, grow upward if there's no room below
        });

        JiTA.logsig._applyPos(panel);
        JiTA.logsig._makeDraggable(panel, head, collapse);
    },

    // Hover preview for a panel entry: look up the defect in the local DB and show the SAME styled card the
    // Similar Defects panel uses (key + summary + status/resolution + description), so you can tell what a
    // logged defect is about without leaving the log. Cached per defect; guarded by _hoverKey so a slow DB
    // read can't pop a tip after the mouse has already left the row.
    _defCache: {},
    _hoverKey: null,
    _showDefectTip: function (key, anchor) {
        if (!JiTA.ui || !JiTA.ui._showTip) { return; }
        JiTA.logsig._hoverKey = key;
        var show = function (rec) {
            if (JiTA.logsig._hoverKey !== key) { return; }   // mouse already left before the read returned
            rec = rec || { key: key };
            var meta = rec.status || '';
            if (rec.resolution) { meta += (meta ? ' · ' : '') + rec.resolution; }
            JiTA.ui._showTip({ key: rec.key || key, summary: rec.summary, description: rec.description }, anchor, meta);
        };
        if (Object.prototype.hasOwnProperty.call(JiTA.logsig._defCache, key)) { show(JiTA.logsig._defCache[key]); return; }
        JiTA.db.getDefect(key).then(function (rec) {
            JiTA.logsig._defCache[key] = rec || null;
            show(rec);
        }, function () { show(null); });
    },

    // Restore a saved {left, top}, clamped on-screen (same approach as the Similar Defects panel).
    _applyPos: function (panel) {
        var pos = null;
        pos = gmGet(JiTA.logsig.POS_KEY, null);
        if (!pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') { return; }
        var w = panel.offsetWidth || 300, h = panel.offsetHeight || 60;
        var left = Math.min(Math.max(0, pos.left), Math.max(0, window.innerWidth - w));
        var top = Math.min(Math.max(0, pos.top), Math.max(0, window.innerHeight - h));
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel._jitaTop = top;              // remember the intended top so _fitVertical can re-anchor on expand
        JiTA.logsig._fitVertical(panel);
    },

    // Keep the (expanded) panel on-screen vertically (same "drop-up" approach as the Similar Defects panel):
    // when positioned by a dragged/saved top and the expanded panel would run off the bottom, pin it by the
    // bottom and reverse the column so the title bar stays put and the list grows UPWARD above it. Only acts
    // when we manage the position via top (dragged / restored), not in the default placement.
    _fitVertical: function (panel) {
        if (!panel) { return; }
        if (typeof panel._jitaTop !== 'number') { return; }
        if (panel.classList.contains('collapsed')) {
            panel.classList.remove('jita-logmatch-up');
            panel.style.maxHeight = '';
            panel.style.bottom = 'auto';
            panel.style.top = panel._jitaTop + 'px';
            return;
        }
        var margin = 8, vh = window.innerHeight;
        panel.classList.remove('jita-logmatch-up');
        panel.style.maxHeight = '';
        panel.style.bottom = 'auto';
        panel.style.top = panel._jitaTop + 'px';
        var headEl = document.getElementById('jita-logmatch-head');
        var headerH = headEl ? headEl.offsetHeight : 34;
        var fullH = panel.offsetHeight;
        if (panel._jitaTop + fullH <= vh - margin) { return; }   // fits growing down -> keep normal layout
        var headerBottom = panel._jitaTop + headerH;
        panel.style.top = 'auto';
        panel.style.bottom = (vh - headerBottom) + 'px';
        panel.style.maxHeight = Math.max(80, Math.min(Math.round(vh * 0.70), headerBottom - margin)) + 'px';
        panel.classList.add('jita-logmatch-up');
    },

    // Drag by the header; persist the dropped position. The collapse control is excluded so it still toggles.
    _makeDraggable: function (panel, head, collapse) {
        var dragging = false, startX = 0, startY = 0, baseLeft = 0, baseTop = 0;
        // We drag by the HEADER's intended top (panel._jitaTop) and let _fitVertical decide, on every move,
        // whether the list grows down (room below) or flips to "drop-up" (no room) - so the flip happens
        // live while dragging, not only on release. We clamp the header top by the header height (not the
        // full panel height) so the header can be moved right down to the bottom edge to trigger drop-up.
        function onMove(e) {
            if (!dragging) { return; }
            var w = panel.offsetWidth;
            var headerH = head ? head.offsetHeight : 34;
            var left = Math.min(Math.max(0, baseLeft + (e.clientX - startX)), Math.max(0, window.innerWidth - w));
            var top = Math.min(Math.max(0, baseTop + (e.clientY - startY)), Math.max(0, window.innerHeight - headerH));
            panel.style.left = left + 'px';
            panel.style.right = 'auto';
            panel._jitaTop = top;                 // _fitVertical sets top/bottom from this (anchor or drop-up)
            JiTA.logsig._fitVertical(panel);
            e.preventDefault();
        }
        function onUp() {
            if (!dragging) { return; }
            dragging = false;
            panel.classList.remove('jita-logmatch-dragging');
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('mouseup', onUp, true);
            var rect = panel.getBoundingClientRect();
            var top = (typeof panel._jitaTop === 'number') ? panel._jitaTop : Math.round(rect.top);
            gmSet(JiTA.logsig.POS_KEY, { left: Math.round(rect.left), top: top });
            JiTA.logsig._fitVertical(panel);
        }
        head.addEventListener('mousedown', function (e) {
            if (e.which && e.which !== 1) { return; }            // left button only
            if (collapse && e.target === collapse) { return; }   // let the collapse toggle work
            // Drag relative to the HEADER's current top (works whether we're top-anchored or in drop-up),
            // so the header tracks the cursor and _fitVertical re-evaluates up/down on every move.
            var hTop = head.getBoundingClientRect().top;
            baseLeft = panel.getBoundingClientRect().left; baseTop = hTop;
            panel._jitaTop = hTop;
            startX = e.clientX; startY = e.clientY;
            dragging = true;
            panel.classList.add('jita-logmatch-dragging');
            document.addEventListener('mousemove', onMove, true);
            document.addEventListener('mouseup', onUp, true);
            e.preventDefault();
        });
    }
};


/* ---- utilities ---- */
JiTA.util = {
    // djb2 string hash -> short hex; used to detect whether an issue's TEXT changed (vs. metadata only)
    hash: function (str) {
        var h = 5381, i = str.length;
        while (i) { h = (h * 33) ^ str.charCodeAt(--i); }
        return (h >>> 0).toString(16);
    },

    // Flatten a Jira description to plain text. Handles both the v2 string form and the v3 ADF object form.
    toPlainText: function (d) {
        if (!d) { return ''; }
        if (typeof d === 'string') { return d; }
        var out = [];
        (function walk(node) {
            if (!node || typeof node !== 'object') { return; }
            if (node.type === 'text' && typeof node.text === 'string') { out.push(node.text); }
            if (node.content && node.content.length) {
                for (var i = 0; i < node.content.length; i++) { walk(node.content[i]); }
            }
        })(d);
        return out.join(' ');
    },

    // Reduce an issue to just the comparable SIGNAL: its summary (weighted, since the one-line problem
    // statement is the densest signal) + the human-written part of the description, with the EVE in-game
    // bug-reporter boilerplate removed. That reporter dumps "Session Info" (character / solar system) and
    // "Computer Info" (OS / GPU / CPU / memory spec) straight into the description; that text is near-identical
    // across every report, so leaving it in makes every defect embed to nearly the same vector (and BM25 match
    // on shared template words) - which is exactly why obvious duplicates were not surfacing. We also unwrap
    // EVE <url=showinfo:ID>name</url> link markup, keeping the visible name AND the numeric IDs (a shared
    // ship/type/message ID between two reports is a very strong duplicate signal).
    // Used by BOTH the stored-defect indexing and the live query, so the two are always normalized the same.
    cleanForCompare: function (summary, description) {
        var s = (summary || '').replace(/\s+/g, ' ').trim();
        var d = ' ' + (description || '') + ' ';
        d = d.replace(/<url=[^>]*>/gi, ' ').replace(/<\/url>/gi, ' ');                          // unwrap in-game links
        d = d.replace(/Session Info\s*:[\s\S]*?(?=Reproduction Steps|Computer Info|$)/i, ' ');  // drop char / solar system
        d = d.replace(/Computer Info[\s\S]*$/i, ' ');                                            // drop the hardware dump (runs to the end)
        d = d.replace(/\b(Reproduction Steps|Description)\b\s*:?/ig, ' ');                       // drop leftover section labels
        d = d.replace(/\bNone\b/g, ' ');
        d = d.replace(/\s+/g, ' ').trim();
        // Weight the summary by repeating it twice so it dominates the pooled embedding / keyword stats.
        return (s ? (s + '. ' + s + '. ') : '') + d;
    },

    // Convert a Jira ISO `updated` timestamp into the JQL literal "yyyy/MM/dd HH:mm".
    // We subtract a 2 minute buffer so a slight timezone/rounding mismatch never SKIPS an updated issue
    // (re-fetching a few extra issues is harmless - bulkPut is idempotent).
    toJqlTime: function (iso) {
        var d = new Date(iso);
        if (isNaN(d.getTime())) { return null; }
        d = new Date(d.getTime() - 2 * 60 * 1000);
        function p(n) { return (n < 10 ? '0' : '') + n; }
        return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    },

    delay: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },

    // True when a defect / bug report is effectively resolved / closed / handled. We check BOTH the resolution
    // field (set on any closed issue) and the status name, because the EVE instance uses custom statuses we
    // can't enumerate. "Attached" is the terminal EBR state set when a bug report is attached to a defect as a
    // duplicate (sometimes WITHOUT a Resolution), so it must count as not-open or those reports get ranked /
    // listed as open in the EDR "matching reports" view.
    // Used by the DEFECT side (stale-match demotion), where a set resolution genuinely means "fixed". The EBR
    // open/closed side uses isClosedStatus() instead - see why there.
    isResolved: function (status, resolution) {
        if (resolution) { return true; }
        return /closed|done|resolved|rejected|cancel|attached/i.test(status || '');
    },

    // True when a BUG REPORT is closed/handled, judged by its STATUS NAME ONLY (open / closed / attached, the
    // same closed-status vocabulary as isResolved) - deliberately NOT the resolution field. A REOPENED bug
    // report typically keeps its old Resolution (the reopen transition doesn't clear it), so a resolution-based
    // check (isResolved) would wrongly treat a reopened-and-open report as closed and hide it from the EDR
    // "matching reports" view. The status is the authoritative open/closed signal for EBRs, so the EBR index /
    // vector index / embed-skip / incremental-sync prune all gate on this.
    isClosedStatus: function (status) {
        return /closed|done|resolved|rejected|cancel|attached/i.test(status || '');
    },

    // Normalize a Team custom-field value (customfield_10001) to a plain id string, or '' when absent. The field
    // can come back as a bare string / number OR an object ({id}/{value}/{teamId}) depending on the Team-field
    // variant, so handle every shape.
    teamId: function (v) {
        if (v == null) { return ''; }
        if (typeof v === 'string' || typeof v === 'number') { return String(v); }
        if (typeof v === 'object') { return String(v.id || v.value || v.teamId || v.name || ''); }
        return '';
    },

    // True when a Team value is "EO - GameMasters". Matches the full id, the short numeric id ('38'), or any
    // "<prefix>-38" form, so it's robust to whichever shape the API / a stored record carries.
    isGmTeam: function (v) {
        var id = JiTA.util.teamId(v);
        if (!id) { return false; }
        var short = String(JiTA.GM_TEAM_ID).split('-').pop();   // '38' - the short numeric team id
        return id === JiTA.GM_TEAM_ID || id === short || id.slice(-(short.length + 1)) === ('-' + short);
    },

    // Stale-match demotion factor. A defect that was FIXED long before this bug report was even filed is
    // very unlikely to be the report's real duplicate, so we gently scale its score down with that gap.
    // Returns { factor (0.5..1), ageDays }. Linear ramp: full weight until `grace` days, decaying to a
    // 0.5 floor by `full` days. ageDays<=grace (or missing/invalid dates) -> factor 1 (no penalty).
    staleFactor: function (brCreatedIso, resolutionDateIso) {
        var GRACE = 30, FULL = 365, FLOOR = 0.5;
        var created = new Date(brCreatedIso).getTime();
        var fixed = new Date(resolutionDateIso).getTime();
        if (isNaN(created) || isNaN(fixed)) { return { factor: 1, ageDays: 0 }; }
        var ageDays = Math.round((created - fixed) / (1000 * 60 * 60 * 24));
        if (ageDays <= GRACE) { return { factor: 1, ageDays: ageDays }; }
        var f = 1 - (1 - FLOOR) * (ageDays - GRACE) / (FULL - GRACE);
        if (f < FLOOR) { f = FLOOR; }
        if (f > 1) { f = 1; }
        return { factor: f, ageDays: ageDays };
    },

    // Human-friendly age like "8mo" / "2y" / "12d" for the stale-match note.
    humanizeAge: function (days) {
        if (days >= 365) { return Math.round(days / 365 * 10) / 10 + 'y'; }
        if (days >= 60) { return Math.round(days / 30) + 'mo'; }
        return days + 'd';
    },

    // Format a Jira ISO timestamp as "DD Mon YYYY" for display (e.g. a suggestion's created date). A textual
    // month keeps it unambiguous across locales (no DD/MM vs MM/DD confusion). Returns '' for missing /
    // invalid input so callers can skip rendering it.
    fmtDate: function (iso) {
        var d = new Date(iso);
        if (isNaN(d.getTime())) { return ''; }
        var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        function p(n) { return (n < 10 ? '0' : '') + n; }
        return p(d.getDate()) + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear();
    }
};


/* ---- hidden ("ignored") suggestions ----
   A user can dismiss a suggested issue for a chosen window (max 90 days). The hidden set is persisted in GM
   storage (NOT IndexedDB) on purpose: GM values survive a script auto-update, whereas a DB rebuild/migration
   could wipe the store. Shape: { issueKey: expiryEpochMs }. The ranking layer skips hidden keys so they never
   take a result slot, and each entry auto-expires (lazily pruned) once its window passes. */
JiTA.hidden = {
    KEY: 'sdHidden',     // GM flag holding the { key: expiryMs } map
    MAX_DAYS: 90,
    _map: null,          // in-memory cache of the parsed GM map (null = not loaded yet)

    // Duration choices offered by the hide popover (all <= MAX_DAYS).
    PRESETS: [
        { label: '1 day', days: 1 },
        { label: '1 week', days: 7 },
        { label: '30 days', days: 30 },
        { label: '90 days', days: 90 }
    ],

    _load: function () {
        if (JiTA.hidden._map) { return JiTA.hidden._map; }
        var m = {};
        m = gmGet(JiTA.hidden.KEY, {}) || {};
        if (!m || typeof m !== 'object') { m = {}; }
        JiTA.hidden._map = m;
        return m;
    },

    _persist: function () {
        gmSet(JiTA.hidden.KEY, JiTA.hidden._map || {});
    },

    // Drop expired entries from the in-memory map; returns true if anything was removed.
    _prune: function () {
        var m = JiTA.hidden._load(), now = Date.now(), changed = false;
        for (var k in m) {
            if (Object.prototype.hasOwnProperty.call(m, k) && !(m[k] > now)) { delete m[k]; changed = true; }
        }
        return changed;
    },

    // Cheap, allocation-free check used in the ranking loops (no persistence side effects - cleanup happens in
    // _prune()/count(), called when the settings menu opens or a hide is added).
    isHidden: function (key) {
        if (!key) { return false; }
        var exp = JiTA.hidden._load()[key];
        return !!exp && exp > Date.now();
    },

    hide: function (key, days) {
        if (!key) { return; }
        var d = Math.max(1, Math.min(JiTA.hidden.MAX_DAYS, parseInt(days, 10) || 0));
        var m = JiTA.hidden._load();
        m[key] = Date.now() + d * 24 * 60 * 60 * 1000;
        JiTA.hidden._prune();
        JiTA.hidden._persist();
    },

    clear: function () {
        JiTA.hidden._map = {};
        JiTA.hidden._persist();
    },

    // Count of currently-active (non-expired) hidden issues; prunes+persists any that have lapsed.
    count: function () {
        if (JiTA.hidden._prune()) { JiTA.hidden._persist(); }
        var m = JiTA.hidden._load(), n = 0;
        for (var k in m) { if (Object.prototype.hasOwnProperty.call(m, k)) { n++; } }
        return n;
    }
};


/* ---- canned ("default") responses repository (Zendesk Support panel) ----
   A small repository of reusable reply texts, surfaced as a dropdown in the Zendesk Support activity panel -
   which renders inside a cross-origin Forge iframe (see JITA_IS_FORGE_FRAME). Picking one REPLACES the comment
   editor's content. Ships a built-in default set; the list is editable from the settings menu and persisted in
   GM storage (shared across frames, survives script updates). */
JiTA.responses = {
    GM_KEY: 'ejfCannedResponses',   // legacy storage key kept as-is (renaming would drop users' saved responses)
    DEFAULTS: [
        { title: 'Support Ticket - General', body: 'We do appreciate you taking the time to contact us. The information for this issue is likely best submitted as a support ticket. I have already assigned this issue to Customer Support. In the future, should you wish to do so, that can be done at the following location: https://support.eveonline.com/hc/requests/new' },
        { title: 'Support Ticket - General (Alternative)', body: 'Thank you for your bug report. Unfortunately it appears that this issue is for our Customer Support department. Please resubmit your issue as a support ticket via the following link: https://support.eveonline.com/hc/requests/new' },
        { title: 'Support Ticket - Account Related', body: 'The Bug Hunter team cannot access any payment or account-related data to help you with this issue. I have already assigned this issue to Customer Support. In the future, please use https://support.eveonline.com/hc/requests/new to file a customer support request instead of a bug report.' },
        { title: 'Support Ticket - Stuck', body: 'The information for this issue is likely best submitted as a support ticket. I have already assigned this issue to Customer Support. In the future, should you wish to do so, that can be done at the following location: https://support.eveonline.com/hc/requests/new You can file a ticket under "Gameplay" and "Stuck".' },
        { title: 'Support Ticket - Mission Reset', body: 'The information for this issue is likely best submitted as a support ticket. I have already assigned this issue to Customer Support. In the future, should you wish to do so, that can be done at the following location. https://support.eveonline.com/hc/requests/new You can file a ticket by navigating to the \'Game Play Support\' section, selecting the \'Agents, AIR Career, Events & Missions\' category, and finalizing your submission under \'Missions > Agent Mission in Progress\'.' },
        { title: 'Support Ticket - Replace/Reimburse', body: 'Bug Hunters do not provide reimbursement or replacement for lost items. I have already assigned this issue to Customer Support. In the future, should you need to, you can submit a support ticket so that they may assist you: https://support.eveonline.com/hc/requests/new' },
        { title: 'Support Ticket - Replace/Reimburse (Alternative)', body: 'Thank you for your bug report. Unfortunately, only Customer Support can handle reimbursements - please submit a support ticket through https://support.eveonline.com/hc/requests/new, so that a Customer Support representative can help you with it.' },
        { title: 'Support Ticket - Investigate', body: 'Thank you for your bug report. While we investigate the underlying problem, I have passed this issue on to the Customer Support team. In the future, if you need to, contact Customer Support by submitting a ticket via the following link, so that a Customer Support representative can help you with it: https://support.eveonline.com/hc/requests/new' },
        { title: 'Defect - Created', body: 'Thank you for your bug report. The information has been reviewed and passed on to developers for further investigation. While we are unable to provide a timeline of a fix, you are encouraged to watch the patch notes here: https://www.eveonline.com/news/t/patch-notes' },
        { title: 'Defect - Exists', body: 'Thank you for your bug report. The developers are already aware of this issue. While we are unable to provide a timeline of a fix, you are encouraged to watch the patch notes here: https://www.eveonline.com/news/t/patch-notes' },
        { title: 'Incomplete - General', body: 'We appreciate you taking the time to contact us, however there is simply not enough information in the report to proceed. If you continue to experience the issue and can reliably reproduce it, please submit a new report with the steps you took, screenshots, and LogLite files as these can help us. Here is a link that might assist you in gathering information to submit a new report: https://community.eveonline.com/support/test-servers/bug-reporting/' },
        { title: 'Incomplete - Logs Needed', body: 'Thank you for your bug report! Unfortunately we need logs from your client which cover the time when this problem happened. Ideally, it would be best to send a bug report through the client (F12 - Report Bug) directly after reproducing the bug. If this is not possible, you can record logs with LogLite (see https://support.eveonline.com/hc/articles/5885024878236-LogLite-tool) and attach them manually to the bug report through the web site.' },
        { title: 'Incomplete - Launcher Logs Needed', body: 'Thank you for your bug report! Unfortunately we need logs from your launcher to be able to see details about your problem. Please follow the instructions at https://support.eveonline.com/hc/articles/5885251968796-Launcher-logs and attach them to the bug report.' },
        { title: 'Incomplete - Crash Dump Needed', body: 'Thank you for submitting a bug report. In order to investigate this further, could you please attach the crash dump file to the bug report? Please see instructions in the support article on how to retrieve this: https://community.eveonline.com/support/test-servers/reporting-crashes/' },
        { title: 'Incomplete - Default Bug Report', body: 'Thank you for submitting a bug report. It seems, though, that the information in your bug report is actually the default example bug report. You need to resubmit your bug report as it pertains to YOUR bug. Please submit a new report with the steps you took, screenshots, and LogLite files as these can help us. Here is a link that might assist you in gathering information to submit a new report: https://community.eveonline.com/support/test-servers/bug-reporting/' },
        { title: 'By Design - General', body: 'Thank you for submitting a bug report. We appreciate you contacting us, but the feature in question is functioning as designed.' },
        { title: 'By Design - Downtime', body: 'Thank you for submitting a bug report. We appreciate you contacting us, but the feature in question is functioning as designed. Downtime can have a wide variety of effects across New Eden. In an attempt to help keep our players and their items safe, downtime is announced early and often prior to the event.' },
        { title: 'Feature Request', body: 'It appears you are attempting to request a new feature be implemented into the game. Feedback is always appreciated from our player base, however, this is not something that Bug Hunters would handle. If you wish to have your idea heard and hopefully make its way into the game, I would direct you to the forums: https://forums.eveonline.com/c/technology-research/player-features-ideas/74 This forum in particular is where you may submit ideas for new features or improvements for EVE. Additionally, you may use the #feature-suggestions channel on the EVE Online Discord (https://www.eveonline.com/discord)' },
        { title: 'Cannot Reproduce', body: 'Thank you for submitting a bug report. However, we were not able to reproduce the issue you brought to our attention. If you are still experiencing this issue and can reliably reproduce it, I\'d suggest including more information when you file a new report. Annotated screenshots of where the exact problem is occurring is always helpful.' },
        { title: 'Shared Cache Issues', body: 'Based on the information you\'ve provided, it seems that there may be a problem with the shared cache of files which is used to run the EVE Client. You can verify the integrity of this cache by:\n- Opening the launcher\n- Clicking the menu icon in the upper right corner\n- Choosing the "shared cache" option under "Tools / Cache"\n- Waiting until the \'Verify\' button is enabled and clicking it\nThe launcher will evaluate the integrity of all of the cached files, and obtain correct and up-to-date versions of those files which are deemed to be corrupt or outdated. If you find that this does not resolve the issue, please let us know and provide as much information as possible regarding the behaviour you\'re seeing so that we might be able to help. Alternatively, if you experience any other behaviour that you suspect to be a bug, please submit a new bug report, again providing as much information as possible.' },
        { title: 'Shared Cache Issues (Alternative)', body: 'It looks like your resource cache might be corrupted. Please open the settings screen in the launcher (icon in the upper right corner), and open the "Shared Cache" settings under "Tools / Cache". There click the "Verify" button. Further info can be found in this article: https://support.eveonline.com/hc/articles/5885307869468-Shared-Cache' },
        { title: 'Clear Client Cache', body: 'It seems like one of your cache files might be corrupted. Please clear your client cache in the client through ESC - Reset Settings - Clear all Cache Files.' },
        { title: 'Unable to Connect to Chat Server', body: 'According to your client logs the client is unable to connect to our chat server. In most cases this is caused by too restrictive firewall settings, but it can also be caused by other connectivity problems. Please check https://support.eveonline.com/hc/articles/5885820948252-Troubleshooting-in-game-chat for more details about this.' },
        { title: 'Aura AI Issues', body: 'Thank you for submitting a bug report. The information has been reviewed and passed onto the developers for review. Whilst Aura guidance is still an experimental feature, we welcome all feedback on how to improve it so it can help new capsuleers.' },
        { title: 'Russian Issues', body: 'Unfortunately due to current global politics, there are specific services that are not accessible for our Russian capsuleers. Whilst we wished this weren\'t the case, these services are outside the control of FC.' },
        { title: 'Broken Anomalies', body: 'Unfortunately there is an issue with NPC waves not spawning correctly. Whilst the Developers are aware, we are unable to provide any timeline for a fix. After downtime the anomalies in the system will reset, resolving this issue.' },
        { title: 'Killmails/Killmarks', body: 'Kill reports are for informational purposes, and processing them takes lowest priority. You might find that some killmails do not show the actual damage that was dealt or taken, or other issues such as not receiving one. In some cases if an involved player travels to a different solar system, docks or undocks, those players that previously engaged may also not appear on the report. This is not something that is manually updated by Bug Hunters, nor are we able to do so.' },
        { title: 'Socket Closed', body: 'Thank you for submitting a bug report. It appears that your client has lost connection with the server causing the socket closed message. I would recommend reading the support article on this to assist you further: https://support.eveonline.com/hc/articles/5876820591772-Disconnects-Socket-closed' },
        { title: 'Tutorial/NPE Operations', body: 'During the starter encounters, you should be able to reset yourself to the last checkpoint by clicking on the small question mark in operations panel. You can also attempt to undock/redock, or log in and out of your client. If for some reason you are unable to resolve the issue by doing any of the above, please follow up with the support department as they may be able to assist you further here: https://support.eveonline.com/hc/requests/new' },
        { title: 'ESI Issues', body: 'Thank you for submitting a bug report. For reporting any ESI related issues, please instead use our official ESI Issues GitHub repository: https://github.com/esi/esi-issues or use the #3rd-party-dev-and-esi channel on the EVE Online Discord (https://www.eveonline.com/discord)' },
        { title: 'Not EVE Related', body: 'Thank you for submitting a bug report. We appreciate you taking the time to contact us, however the issue in question is not supported by EVE Online directly or deals with outside factors/services beyond our control.' },
        { title: 'Security Related', body: 'Thank you for your report, we appreciate your concern and will forward this information to the security team within Fenris Creations. If you have any further substantial evidence which supports your report, please add it to this ticket. Please note that the security team may not respond to this ticket unless additional information is required but you can rest assured that your report will be reviewed. Should you come across other suspicious behavior in the future, we would like to point you to two other communications channels. The customer support department as well as the REPLACE WITH TEAM NAME are not directly involved in detecting and policing Real Money Trading, abuse of macros, bots and other illegitimate third party programs, that responsibility lies with Team Security, a team of specialists responsible for enforcing this side of EVE. The following two channels are the most efficient way of bringing suspected abuse of this kind to their attention:\n- Please file a support ticket or\n- send a mail directly to security@fenriscreations.com.\nMake sure to include the names of the character(s) involved, time of the alleged illicit activity and any other pertinent details you possess. For all other reports of suspected third party program abuse, please utilize the "Report bot" function in the EVE game client. Here are the steps submit a bot report:\n- Right click on the character you wish to report and select show info.\n- Click the button in the upper-left corner of the character information screen to open the action menu.\n- Select "Report Bot".\nMore information on the bot report tool and further instructions on how to operate it can be found in the blog: https://www.eveonline.com/article/the-eve-security-taskforce-report-a-bot/ I will now move this ticket to the attention of the security team.\nThanks and fly safe,' }
    ],

    // ---- repository model: store ONLY the user's deltas, not a full snapshot ----
    // GM holds an OVERLAY on top of DEFAULTS: { v:2, overrides:{<defaultTitle>:{title,body}}, deleted:[...],
    // added:[{title,body}] }. A response the user NEVER touched is not stored, so it stays a live DEFAULT and
    // picks up wording fixes from script updates. Only EDITED defaults (overrides), DELETED defaults, and
    // user-ADDED responses are persisted. A legacy full-array value is migrated to this shape on first read.
    _isArr: function (v) { return Object.prototype.toString.call(v) === '[object Array]'; },
    _emptyOverlay: function () { return { overrides: {}, deleted: [], added: [] }; },

    // Diff a legacy full snapshot (array of {title,body}) against DEFAULTS into an overlay. A title that
    // matches a default with the SAME body is dropped (unedited -> tracks the default); a different body
    // becomes an override; an unmatched title becomes an addition; a default missing from the array is a
    // deletion. (A default whose wording changed in a script update will look "edited" here - Restore
    // defaults clears the overlay if you want the fresh text.)
    _legacyToOverlay: function (arr) {
        var defs = JiTA.responses.DEFAULTS, dByTitle = {}, i;
        for (i = 0; i < defs.length; i++) { dByTitle[defs[i].title] = defs[i]; }
        var ov = JiTA.responses._emptyOverlay(), present = {};
        for (i = 0; i < arr.length; i++) {
            var r = arr[i] || {}, d = dByTitle[r.title];
            if (d) {
                present[r.title] = true;
                if ((r.body || '') !== (d.body || '')) { ov.overrides[r.title] = { title: r.title, body: r.body || '' }; }
            } else {
                ov.added.push({ title: r.title || 'Untitled', body: r.body || '' });
            }
        }
        for (i = 0; i < defs.length; i++) { if (!present[defs[i].title]) { ov.deleted.push(defs[i].title); } }
        return ov;
    },

    // Parse the stored overlay (migrating + persisting a legacy array on first read). Always returns a
    // well-formed { overrides, deleted, added }.
    _overlay: function () {
        var raw = null;
        raw = gmGet(JiTA.responses.GM_KEY, null);
        if (!raw) { return JiTA.responses._emptyOverlay(); }
        if (JiTA.responses._isArr(raw)) {                 // legacy full snapshot -> migrate once
            var ov = JiTA.responses._legacyToOverlay(raw);
            JiTA.responses._saveOverlay(ov);
            return ov;
        }
        if (typeof raw === 'object') {
            return {
                overrides: (raw.overrides && typeof raw.overrides === 'object') ? raw.overrides : {},
                deleted: JiTA.responses._isArr(raw.deleted) ? raw.deleted : [],
                added: JiTA.responses._isArr(raw.added) ? raw.added : []
            };
        }
        return JiTA.responses._emptyOverlay();
    },

    _saveOverlay: function (ov) {
        gmSet(JiTA.responses.GM_KEY, { v: 2, overrides: ov.overrides || {}, deleted: ov.deleted || [], added: ov.added || [] });
    },

    // The effective list = DEFAULTS (minus deletions, with overrides applied) + user additions. Each item is
    // annotated with `_orig` (the default title it derives from) so the editor's Save can tell an unedited
    // default from an edit; added items have no `_orig`. New defaults from a script update appear automatically
    // (they're in DEFAULTS, not deleted, not overridden).
    load: function () {
        var defs = JiTA.responses.DEFAULTS, ov = JiTA.responses._overlay(), i;
        var del = {};
        for (i = 0; i < ov.deleted.length; i++) { del[ov.deleted[i]] = true; }
        var usedOverride = {}, out = [];
        for (i = 0; i < defs.length; i++) {
            var d = defs[i];
            if (del[d.title]) { continue; }
            var o = ov.overrides[d.title];
            if (o) { usedOverride[d.title] = true; out.push({ title: o.title, body: o.body, _orig: d.title }); }
            else { out.push({ title: d.title, body: d.body, _orig: d.title }); }
        }
        // Overrides whose default no longer exists (removed upstream) survive as custom responses.
        for (var k in ov.overrides) {
            if (!Object.prototype.hasOwnProperty.call(ov.overrides, k) || usedOverride[k] || del[k]) { continue; }
            var stillDefault = false;
            for (i = 0; i < defs.length; i++) { if (defs[i].title === k) { stillDefault = true; break; } }
            if (!stillDefault) { out.push({ title: ov.overrides[k].title, body: ov.overrides[k].body }); }
        }
        for (i = 0; i < ov.added.length; i++) { out.push({ title: ov.added[i].title, body: ov.added[i].body }); }
        return out;
    },

    // Persist ONLY the deltas from `rows` (the editor's current list, each row carrying `_orig`). An unedited
    // default contributes nothing; an edited default -> override (keyed by its original default title); a row
    // with no `_orig` -> an addition; a default with no surviving row -> a deletion.
    save: function (rows) {
        rows = rows || [];
        var defs = JiTA.responses.DEFAULTS, dByTitle = {}, i;
        for (i = 0; i < defs.length; i++) { dByTitle[defs[i].title] = defs[i]; }
        var ov = JiTA.responses._emptyOverlay(), present = {};
        for (i = 0; i < rows.length; i++) {
            var r = rows[i] || {}, orig = (r._orig === undefined || r._orig === null) ? null : r._orig;
            var d = (orig != null) ? dByTitle[orig] : null;
            if (d) {
                present[orig] = true;
                if ((r.title || '') !== (d.title || '') || (r.body || '') !== (d.body || '')) {
                    ov.overrides[orig] = { title: r.title || '', body: r.body || '' };
                }
            } else {
                ov.added.push({ title: r.title || 'Untitled', body: r.body || '' });
            }
        }
        for (i = 0; i < defs.length; i++) { if (!present[defs[i].title]) { ov.deleted.push(defs[i].title); } }
        JiTA.responses._saveOverlay(ov);
    },

    // Restore the built-in defaults (clears the whole overlay so load() returns pure DEFAULTS).
    reset: function () {
        gmSet(JiTA.responses.GM_KEY, null);
    },

    // Optional opening + closing lines the user configures once (e.g. "Greetings Capsuleer," /
    // "Thank you and fly safe o7"). They are wrapped around EVERY picked response on insert, so the canned
    // bodies stay greeting-free and reusable. Persisted in GM (shared across frames, survive script updates);
    // either can be left blank to skip it.
    OPENER_KEY: 'ejfRespOpener',   // legacy storage key kept as-is for backward compat
    CLOSING_KEY: 'ejfRespClosing',   // legacy storage key kept as-is for backward compat
    loadOpener: function () { return gmGet(JiTA.responses.OPENER_KEY, '') || ''; },
    loadClosing: function () { return gmGet(JiTA.responses.CLOSING_KEY, '') || ''; },
    saveAffixes: function (opener, closing) {
        gmSet(JiTA.responses.OPENER_KEY, opener || '');
        gmSet(JiTA.responses.CLOSING_KEY, closing || '');
    },

    // Wrap `body` with the configured opener / closing, each on its own line (a single line break after the
    // greeting and before the closing line; omitted when blank).
    _compose: function (body) {
        var opener = JiTA.responses.loadOpener(), closing = JiTA.responses.loadClosing();
        var parts = [];
        if (opener) { parts.push(opener); }
        parts.push(body || '');
        if (closing) { parts.push(closing); }
        return parts.join('\n');
    },

    // Standalone, roomier editor for the canned responses, opened by the settings menu's "Customize
    // responses" button (the menu itself just shows that button + Restore defaults now, so it stays compact).
    // Reuses the settings-menu overlay chrome (#jita-menu-overlay / #jita-menu) widened via .jita-menu-wide, and
    // the same .jita-resp-* row styling. Edits persist to GM (shared across frames, survive script updates).
    _editorCssInjected: false,
    _injectEditorCss: function () {
        if (JiTA.responses._editorCssInjected) { return; }
        // Flex column layout so the header + the action footer stay pinned while only the middle scrolls,
        // plus collapsible section groups and collapsible response rows (body hidden until the row is opened).
        try { GM_addStyle('#jita-menu.jita-menu-wide { width: 560px; max-width: 92vw; display: flex; flex-direction: column; overflow: hidden; }\
#jita-menu.jita-menu-wide .jita-menu-head { flex: 0 0 auto; }\
#jita-menu .jita-resp-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px 14px 10px; }\
#jita-menu .jita-resp-foot { flex: 0 0 auto; display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 14px; border-top: 1px solid #3a434d; background: #282d33; }\
#jita-menu .jita-resp-subhead { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #7a8694; margin: 12px 0 4px; }\
#jita-menu .jita-resp-affix { display: flex; flex-direction: column; gap: 6px; padding: 2px 0 4px; }\
#jita-menu .jita-resp-caret { color: #9aa6b2; font-size: 10px; width: 12px; flex: 0 0 auto; text-align: center; }\
#jita-menu .jita-resp-group { border: 1px solid #2c333a; border-radius: 6px; margin-bottom: 8px; overflow: hidden; }\
#jita-menu .jita-resp-group-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: #22272b; cursor: pointer; user-select: none; font-weight: 700; font-size: 12px; }\
#jita-menu .jita-resp-group-head:hover { background: #262c31; }\
#jita-menu .jita-resp-group-head .jita-resp-gname { flex: 1 1 auto; }\
#jita-menu .jita-resp-group-head .jita-resp-gcount { color: #7a8694; font-weight: 400; font-size: 11px; }\
#jita-menu .jita-resp-gadd { flex: 0 0 auto; font-size: 11px; font-weight: 400; color: #9aa6b2; background: #2c333a; border: 1px solid #3a434d; border-radius: 4px; padding: 2px 8px; cursor: pointer; }\
#jita-menu .jita-resp-gadd:hover { color: #fff; border-color: #4c9aff; }\
#jita-menu .jita-resp-gdel { flex: 0 0 auto; width: 22px; height: 22px; line-height: 1; font-size: 16px; color: #9aa6b2; background: transparent; border: 1px solid #3a434d; border-radius: 4px; cursor: pointer; }\
#jita-menu .jita-resp-gdel:hover { color: #fff; background: #5a2a2a; border-color: #a85a5a; }\
#jita-menu .jita-resp-group.collapsed .jita-resp-group-body { display: none; }\
#jita-menu .jita-resp-group-body { padding: 6px 8px; display: flex; flex-direction: column; gap: 6px; }\
#jita-menu .jita-resp-item { display: block; position: static; padding: 0; margin: 0; gap: 0; border: 1px solid #2c333a; border-radius: 6px; overflow: hidden; }\
#jita-menu .jita-resp-item-head { display: flex; align-items: center; gap: 6px; padding: 6px 6px 6px 8px; background: #14181b; cursor: pointer; }\
#jita-menu .jita-resp-item .jita-resp-title { flex: 1 1 auto; padding: 5px 8px; cursor: text; }\
#jita-menu .jita-resp-del { position: static; width: 22px; height: 22px; flex: 0 0 auto; }\
#jita-menu .jita-resp-item-body { padding: 6px 8px; }\
#jita-menu .jita-resp-item.collapsed .jita-resp-item-body { display: none; }\
#jita-menu .jita-resp-item .jita-resp-body { width: 100%; box-sizing: border-box; }'); } catch (e) { /* ignore */ }
        JiTA.responses._editorCssInjected = true;
    },

    // Section name for a response, derived from its title prefix ("Support Ticket - General" -> "Support
    // Ticket"); titles without a " - " separator fall into "Other". Used to group both the editor and the
    // Zendesk dropdown (via <optgroup>). `_titleTail` is the remainder shown inside a section.
    _sectionOf: function (title) {
        var t = (title || '').trim();
        var idx = t.indexOf(' - ');
        return idx > 0 ? t.slice(0, idx).trim() : 'Other';
    },
    _titleTail: function (title) {
        var t = (title || '').trim();
        var idx = t.indexOf(' - ');
        return idx > 0 ? t.slice(idx + 3).trim() : t;
    },

    openEditor: function () {
        JiTA.responses._injectEditorCss();
        var ov = JiTA.menu._openOverlay({ title: 'Customize responses', wide: true });
        var $menu = ov.$menu, closeEditor = ov.close;
        // Scrollable middle region (header + footer stay pinned via the flex layout in _injectEditorCss).
        var $scroll = $('<div class="jita-resp-scroll"></div>').appendTo($menu);
        $('<div class="jita-menu-status">These appear in the dropdown in the Zendesk Support panel; picking one replaces the comment editor.</div>').appendTo($scroll);
        // Opening / closing lines wrapped around EVERY inserted response (left blank = skipped).
        $('<div class="jita-resp-subhead">Opening &amp; closing</div>').appendTo($scroll);
        $('<div class="jita-menu-status" style="padding:0 0 6px;">Added around every response on insert. Leave blank to skip.</div>').appendTo($scroll);
        var $affix = $('<div class="jita-resp-affix"></div>').appendTo($scroll);
        // Textareas (not single-line inputs) so the opener / closing can themselves span multiple lines.
        var $openerIn = $('<textarea class="jita-resp-body" rows="2" placeholder="Opening line - e.g. Greetings Capsuleer,"></textarea>').val(JiTA.responses.loadOpener()).appendTo($affix);
        var $closingIn = $('<textarea class="jita-resp-body" rows="2" placeholder="Closing line - e.g. Thank you and fly safe o7"></textarea>').val(JiTA.responses.loadClosing()).appendTo($affix);
        $('<div class="jita-resp-subhead">Responses</div>').appendTo($scroll);
        var $groups = $('<div class="jita-resp-groups"></div>').appendTo($scroll);

        // Re-count each section header from the rows it currently holds (after add / delete).
        function updateCounts() {
            $groups.children('.jita-resp-group').each(function () {
                var $g = $(this), n = $g.find('.jita-resp-item').length;
                $g.find('.jita-resp-gcount').text(n + (n === 1 ? ' response' : ' responses'));
            });
        }

        // A collapsible response row: only the title bar shows by default; clicking it (anywhere but the title
        // input or the delete button) toggles the body textarea open for editing.
        function respRow(item, expanded) {
            var $row = $('<div class="jita-resp-item' + (expanded ? '' : ' collapsed') + '"></div>');
            if (item && item._orig != null) { $row.attr('data-orig', item._orig); }   // provenance: which default this row derives from (so Save can diff)
            var $head = $('<div class="jita-resp-item-head"></div>');
            var $caret = $('<span class="jita-resp-caret"></span>').text(expanded ? '▾' : '▸');
            var $title = $('<input type="text" class="jita-resp-title" placeholder="Title">').val((item && item.title) || '');
            var $del = $('<button class="jita-resp-del" title="Remove">×</button>');
            $head.append($caret).append($title).append($del);
            var $body = $('<div class="jita-resp-item-body"></div>');
            $('<textarea class="jita-resp-body" rows="6" placeholder="Response text"></textarea>').val((item && item.body) || '').appendTo($body);
            $row.append($head).append($body);
            function toggle() { $caret.text($row.toggleClass('collapsed').hasClass('collapsed') ? '▸' : '▾'); }
            $head.on('click', function (e) {
                if ($(e.target).is('input') || $(e.target).closest('.jita-resp-del').length) { return; }
                toggle();
            });
            $del.on('click', function (e) { e.stopPropagation(); $row.remove(); updateCounts(); });
            return $row;
        }

        // Find (or build) the collapsible section group for `name`, returning its body element. Each header
        // carries a "+ Add" button that drops a new row straight into THAT section (its prefix prefilled into
        // the title), so a response can be added to any section, not just "Other".
        var groupBodies = {};
        function ensureGroup(name) {
            if (groupBodies[name]) { return groupBodies[name]; }
            var $g = $('<div class="jita-resp-group collapsed"></div>');   // sections start collapsed
            var $gh = $('<div class="jita-resp-group-head"></div>');
            var $gcaret = $('<span class="jita-resp-caret"></span>').text('▸');
            var $gadd = $('<button class="jita-resp-gadd" title="Add a response to this section">+ Add</button>');
            var $gdel = $('<button class="jita-resp-gdel" title="Delete this section and all its responses">×</button>');
            $gh.append($gcaret).append($('<span class="jita-resp-gname"></span>').text(name)).append($('<span class="jita-resp-gcount"></span>')).append($gadd).append($gdel);
            var $gb = $('<div class="jita-resp-group-body"></div>');
            $gh.on('click', function () { $gcaret.text($g.toggleClass('collapsed').hasClass('collapsed') ? '▸' : '▾'); });
            // The "Other" bucket isn't a real prefix, so its new rows start title-less; named sections prefill
            // "<name> - " so the saved title keeps the row in this section (sections are derived from the title).
            $gadd.on('click', function (e) { e.stopPropagation(); addRowTo(name, name === 'Other' ? '' : (name + ' - ')); });
            // Delete the whole section (and every response in it). Confirm only when it actually holds rows.
            $gdel.on('click', function (e) {
                e.stopPropagation();
                var n = $gb.find('.jita-resp-item').length;
                if (n && !confirm('Delete the "' + name + '" section and its ' + n + ' response' + (n === 1 ? '' : 's') + '?')) { return; }
                $g.remove();
                delete groupBodies[name];
            });
            $g.append($gh).append($gb);
            $groups.append($g);
            groupBodies[name] = $gb;
            return $gb;
        }

        // Add a fresh, expanded response row to section `name`, optionally prefilling its title, then expand
        // the section and focus the title (cursor at the end of any prefilled prefix). Shared by every "+ Add"
        // control (per-section headers, the footer "Add response", and "Add section").
        function addRowTo(name, prefill) {
            var $gb = ensureGroup(name);
            $gb.closest('.jita-resp-group').removeClass('collapsed')
               .find('.jita-resp-group-head .jita-resp-caret').first().text('▾');
            var $row = respRow(prefill ? { title: prefill, body: '' } : null, true);
            $gb.append($row);
            updateCounts();
            $row[0].scrollIntoView({ block: 'nearest' });
            var $t = $row.find('.jita-resp-title').focus();
            var el = $t[0];
            if (el && el.setSelectionRange) { var L = (el.value || '').length; try { el.setSelectionRange(L, L); } catch (e) { /* ignore */ } }
            return $row;
        }

        function fillRows(list) {
            $groups.empty();
            groupBodies = {};
            (list || []).forEach(function (it) { ensureGroup(JiTA.responses._sectionOf(it.title)).append(respRow(it, false)); });
            updateCounts();
        }
        fillRows(JiTA.responses.load());

        // Pinned action footer (always visible regardless of scroll position).
        var $foot = $('<div class="jita-resp-foot"></div>').appendTo($menu);
        $('<button class="jita-btn">Add section</button>')
            .on('click', function () {
                var name = (prompt('New section name (e.g. "Support Ticket", "Defect"):', '') || '').trim();
                if (!name) { return; }
                if (/ - /.test(name)) { name = name.split(' - ')[0].trim(); }   // a section is just the prefix
                if (!name) { return; }
                // Add the first response straight into the new section (prefix prefilled so it sticks there).
                addRowTo(name, name + ' - ');
            }).appendTo($foot);
        $('<button class="jita-btn">Save</button>')
            .on('click', function () {
                var list = [];
                $groups.find('.jita-resp-item').each(function () {
                    var $i = $(this);
                    var t = ($i.find('.jita-resp-title').val() || '').trim();
                    var b = $i.find('.jita-resp-body').val() || '';
                    if (t || b.trim()) {
                        var orig = $i.attr('data-orig');
                        list.push({ title: t || 'Untitled', body: b, _orig: (orig === undefined ? null : orig) });
                    }
                });
                JiTA.responses.save(list);
                JiTA.responses.saveAffixes(($openerIn.val() || '').trim(), ($closingIn.val() || '').trim());
                JiTA.ui.toast('Saved ' + list.length + ' canned response' + (list.length === 1 ? '' : 's') + '.');
                closeEditor();
            }).appendTo($foot);
        $('<button class="jita-btn">Restore defaults</button>')
            .on('click', function () {
                if (!confirm('Restore the built-in default responses? Your custom edits will be lost.')) { return; }
                JiTA.responses.reset();
                fillRows(JiTA.responses.load());
            }).appendTo($foot);
    },

    // Replace the open comment editor's content with `body`. The Zendesk panel uses an Atlassian ProseMirror
    // editor (the single contenteditable=true instance; the comment-history editors are read-only). We focus
    // it, select all, then execCommand('insertText') so ProseMirror's own input handling rebuilds the document
    // (more reliable than poking its internal model). Returns false if no editable editor is present.
    // The Zendesk panel's ACTIVE compose editor: the nearest editable ProseMirror to OUR dropdown anchor. A
    // global querySelector would match a DIFFERENT editor (the JQL search box, or an INACTIVE tab's editor that
    // never clears), which is why the text landed in the wrong field AND why the post-success poll misfired.
    _composerEditor: function () {
        var SEL = 'div.ProseMirror[contenteditable="true"], [role="textbox"][contenteditable="true"]';
        var anchor = document.getElementById('jita-resp-col');
        for (var node = anchor && anchor.parentNode; node && node.querySelector; node = node.parentNode) {
            var cand = node.querySelector(SEL);
            if (cand) { return cand; }   // nearest enclosing editor == the Zendesk panel's compose box
        }
        return document.querySelector(SEL);   // fallback (shouldn't normally be needed)
    },

    apply: function (body) {
        var ed = JiTA.responses._composerEditor();
        if (!ed) { return false; }
        ed.focus();
        try {
            // ProseMirror collapses any "\n" passed straight to insertText, so we drive the block structure
            // ourselves with insertParagraph: clear the editor, then re-insert each line as its own paragraph
            // (a blank line "\n\n" becomes an empty paragraph, so the body's spacing is preserved verbatim).
            //  - A line starting with "- " / "•" is a bullet-list item. We CANNOT make a NATIVE editor list
            //    node from here: ProseMirror's "type '- ' -> bullet list" input rule fires ONLY on real
            //    keyboard input, and programmatic execCommand('insertText') bypasses it entirely (verified -
            //    inserting "- " just yields a literal dash, and a toolbar-button click would race the editor's
            //    async DOM-sync). So each item is rendered with a leading "• " glyph, which reads as a bullet
            //    list and is 100% reliable.
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
            var lines = String(body == null ? '' : body).split('\n');
            for (var i = 0; i < lines.length; i++) {
                if (i > 0) { document.execCommand('insertParagraph', false, null); }
                var line = lines[i];
                var m = /^[-•]\s+/.exec(line);
                var text = m ? ('• ' + line.slice(m[0].length)) : line;
                if (text) { document.execCommand('insertText', false, text); }
            }
            return true;
        } catch (e) { return false; }
    },

    // Populate (or repopulate) the dropdown's <option>s from the repository. Guarded by a signature so a
    // re-inject during the user's interaction doesn't clobber an in-progress selection.
    _fill: function (sel) {
        var list = JiTA.responses.load();
        var sig = list.map(function (r) { return r.title; }).join('');
        if (sel.getAttribute('data-jita-sig') !== sig) {
        sel.setAttribute('data-jita-sig', sig);
        sel.innerHTML = '';
        // Explicit dark colors on every option / optgroup so the native popup is readable in Chrome (which
        // otherwise paints unstyled options on a white system background).
        var OPT_CSS = 'background:#1d2125;color:#e6e6e6;';
        var ph = document.createElement('option');
        ph.value = '';
        ph.textContent = list.length ? 'Insert a response…' : 'No responses configured';
        ph.style.cssText = OPT_CSS;
        sel.appendChild(ph);
        // Group into <optgroup>s by section (derived from the title prefix), showing the short tail inside.
        var groups = {};
        for (var i = 0; i < list.length; i++) {
            var sec = JiTA.responses._sectionOf(list[i].title);
            var grp = groups[sec];
            if (!grp) { grp = groups[sec] = document.createElement('optgroup'); grp.label = sec; grp.style.cssText = OPT_CSS; sel.appendChild(grp); }
            var o = document.createElement('option');
            o.value = String(i);
            o.textContent = JiTA.responses._titleTail(list[i].title) || ('Response ' + (i + 1));
            o.style.cssText = OPT_CSS;
            grp.appendChild(o);
        }
        sel.value = '';
        }
        JiTA.responses._setDisplay(list);
    },

    // Reset the (cloned react-select) display text back to the placeholder. The dropdown is an ACTION menu, so
    // after each pick it returns to the placeholder rather than showing the last choice. No-op on the fallback
    // path (a plain <select> shows its own option text).
    _setDisplay: function (list) {
        var v = document.querySelector('[data-jita-respval]');
        if (v) { v.textContent = (list || JiTA.responses.load()).length ? 'Insert a response…' : 'No responses configured'; }
    },

    // Switch the Zendesk composer to its "Add public reply" tab (it defaults to "Add internal note"). The
    // composer is an Atlassian Tabs widget; each tab is a role="tab" element whose text is the label. We match
    // the public-reply tab by text and click it unless it's already selected. Returns true if found.
    _selectPublicReply: function () {
        var tabs = document.querySelectorAll('[role="tab"]');
        for (var i = 0; i < tabs.length; i++) {
            if ((tabs[i].textContent || '').trim().toLowerCase() === 'add public reply') {
                if (tabs[i].getAttribute('aria-selected') !== 'true') { tabs[i].click(); }
                return true;
            }
        }
        return false;
    },

    // Shared change handler for the overlay/fallback <select>: switch the composer to the public-reply tab,
    // insert the picked response, then reset the dropdown to its placeholder. We select the tab FIRST because
    // switching tabs swaps in the public-reply editor instance; a short delay lets React mount it before we
    // write into it (the editor lookup in apply() then targets the now-active public-reply box).
    _onPick: function () {
        var sel = document.getElementById('jita-resp-select');
        if (!sel) { return; }
        var i = parseInt(sel.value, 10);
        var list = JiTA.responses.load();
        if (!isNaN(i) && list[i]) {
            var body = JiTA.responses._compose(list[i].body);   // wrap with the configured opener / closing
            var switched = JiTA.responses._selectPublicReply();
            setTimeout(function () { JiTA.responses.apply(body); }, switched ? 80 : 0);
        }
        sel.value = '';
        JiTA.responses._setDisplay(list);
    },

    // True once a react-select column has finished rendering its chrome (the styled control box + the chevron
    // indicator + a populated value). We MUST wait for this before cloning, otherwise we copy the loading
    // skeleton (a borderless empty box) and the dropdown ends up looking blank.
    _ready: function (srcCol) {
        var control = srcCol.querySelector('[class*="-control"]');
        var indic = srcCol.querySelector('[class*="ndicator"]');   // -IndicatorsContainer / -indicatorContainer
        var val = srcCol.querySelector('[id$="-single-value"]');
        return !!(control && indic && val && (val.textContent || '').trim());
    },

    // Build / refresh the dropdown in the Zendesk Support panel (the empty region to the right of the ticket
    // selector). We CLONE the SUBDOMAIN selector, not the ticket selector: the subdomain dropdown renders and
    // populates noticeably faster (the ticket list is fetched after it), so cloning it makes our dropdown
    // appear sooner and far less likely to catch the source mid-load. Both columns share the same flex row,
    // so the clone still lands to the right of the ticket selector. Idempotent: re-fills an existing dropdown,
    // or builds one next to the source column.
    inject: function () {
        var srcLabel = document.querySelector('label[for="subdomain-select"]');
        if (!srcLabel || !srcLabel.parentNode || !srcLabel.parentNode.parentNode) { return; }
        var srcCol = srcLabel.parentNode;                  // the subdomain-select column (label + react-select)
        var row = srcCol.parentNode;                       // flex row holding the subdomain + ticket columns
        var sel = document.getElementById('jita-resp-select');
        if (!document.getElementById('jita-resp-col')) {
            if (!JiTA.responses._ready(srcCol)) { return; }   // wait for the source select to finish rendering
            sel = JiTA.responses._build(srcCol, row);
        }
        if (sel) { JiTA.responses._fill(sel); }
    },

    // Build the dropdown column. Preferred path: CLONE the source react-select column (the subdomain selector)
    // so the control looks pixel-identical to the native react-select dropdowns, then overlay a transparent
    // native <select> on top for interaction (we can't drive react-select's React state, so we reuse only its
    // chrome). Fallback: a plain styled <select> if the clone fails. Returns the <select> element (or null).
    _build: function (srcCol, row) {
        var sel = null, i;
        try {
            var col = srcCol.cloneNode(true);
            col.id = 'jita-resp-col';
            col.style.marginLeft = '4px';
            var lbl = col.querySelector('label');
            if (lbl) { lbl.textContent = 'Insert default response'; lbl.removeAttribute('for'); }
            // The react-select "single value" text element (tag it so _setDisplay can update it).
            var valEl = col.querySelector('[id$="-single-value"]') || col.querySelector('[class*="-singleValue"]');
            // The control wrapper (react-select container) - we overlay the native <select> on top of it.
            var box = lbl ? lbl.nextElementSibling : col.querySelector('[class*="-container"]');
            if (!box) { throw new Error('no control box in clone'); }
            // Strip identifying attributes so the clone can't shadow Jira's / react-select's id/testid lookups,
            // and remove the cloned react-select search input (it would otherwise steal focus / typing).
            var nodes = col.querySelectorAll('*');
            for (i = 0; i < nodes.length; i++) {
                nodes[i].removeAttribute('data-testid');
                nodes[i].removeAttribute('data-vc');
                nodes[i].removeAttribute('data-component-selector');
                if (nodes[i].id) { nodes[i].removeAttribute('id'); }
            }
            var inputs = col.querySelectorAll('input');
            for (i = 0; i < inputs.length; i++) { if (inputs[i].parentNode) { inputs[i].parentNode.removeChild(inputs[i]); } }
            if (valEl) { valEl.setAttribute('data-jita-respval', '1'); valEl.textContent = 'Insert a response…'; }
            box.style.position = 'relative';
            sel = document.createElement('select');
            sel.id = 'jita-resp-select';
            // The control box is opacity:0 (the cloned react-select chrome shows through), but Chrome draws
            // the NATIVE option popup from the <select>'s OWN colors - a transparent background makes that
            // popup render white. So give it a real dark background + color-scheme:dark; opacity:0 keeps the
            // box itself invisible, while the popup picks up the dark palette.
            sel.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%; margin:0; padding:0; border:0; background:#1d2125; color:#e6e6e6; color-scheme:dark; opacity:0; cursor:pointer; z-index:2;';
            sel.addEventListener('change', JiTA.responses._onPick);
            box.appendChild(sel);
            row.appendChild(col);
            return sel;
        } catch (e) {
            // Fallback: a plain styled select that approximates the native look.
            if (document.getElementById('jita-resp-col')) { return document.getElementById('jita-resp-select'); }
            var fcol = document.createElement('div');
            fcol.id = 'jita-resp-col';
            fcol.style.cssText = 'display:flex; flex-direction:column; margin-left:4px; min-width:220px; max-width:320px; box-sizing:border-box;';
            var flbl = document.createElement('label');
            flbl.textContent = 'Insert default response';
            flbl.style.cssText = 'font-size:12px; font-weight:600; color:var(--ds-text-subtle,#8c9bab); margin-bottom:4px;';
            fcol.appendChild(flbl);
            sel = document.createElement('select');
            sel.id = 'jita-resp-select';
            sel.style.cssText = 'height:40px; box-sizing:border-box; padding:0 8px; border-radius:3px;' +
                ' border:1px solid var(--ds-border-input,#8590a2); background:var(--ds-surface,#22272b);' +
                ' color:var(--ds-text,#c7d1db); color-scheme:dark; font-size:14px; outline:none; cursor:pointer;';
            sel.addEventListener('change', JiTA.responses._onPick);
            fcol.appendChild(sel);
            row.appendChild(fcol);
            return sel;
        }
    }
};


/* ---- storage layer: IndexedDB ---- */
JiTA.db = {
    _db: null,
    _frame: null,

    // Atlassian's consent gate (the parse-gates-and-init-controls early-entry script) now WRAPS the page's
    // window.indexedDB and rejects open() with "The database was blocked by consent preferences" unless the
    // user has consented to the matching cookie category. Our cache is first-party FUNCTIONAL storage (no
    // tracking), so we sidestep the wrapper by taking a PRISTINE IDBFactory from a freshly-created, same-origin
    // about:blank iframe - a realm the gate script never executed in, so its indexedDB / IDBKeyRange are the
    // untouched native APIs. Same origin => same database, so already-synced data is preserved. The iframe must
    // stay attached for the lifetime of every DB connection (removing it would close the connection), so we
    // create it once and cache it. Falls back to the (possibly gated) main-window APIs if the iframe trick fails.
    _win: function () {
        if (JiTA.db._frame && JiTA.db._frame.contentWindow && JiTA.db._frame.contentWindow.indexedDB) {
            return JiTA.db._frame.contentWindow;
        }
        try {
            var f = document.createElement('iframe');
            f.style.display = 'none';
            f.setAttribute('aria-hidden', 'true');
            (document.documentElement || document.body).appendChild(f);
            if (f.contentWindow && f.contentWindow.indexedDB) { JiTA.db._frame = f; return f.contentWindow; }
            if (f.parentNode) { f.parentNode.removeChild(f); }
        } catch (e) { /* fall through to the main window */ }
        return window;
    },
    // Native IDBFactory + IDBKeyRange from the pristine iframe realm (see _win). Use these EVERYWHERE instead
    // of window.indexedDB / IDBKeyRange, and keep the key-range from the SAME realm as the connection so a
    // cross-realm IDBKeyRange isn't rejected.
    _idb: function () { return JiTA.db._win().indexedDB || window.indexedDB; },
    _keyRange: function () { return JiTA.db._win().IDBKeyRange || window.IDBKeyRange; },

    open: function () {
        if (JiTA.db._db) { return Promise.resolve(JiTA.db._db); }
        return new Promise(function (resolve, reject) {
            var req = JiTA.db._idb().open(JiTA.DB_NAME, JiTA.DB_VERSION);
            req.onupgradeneeded = function (e) {
                var db = e.target.result;
                if (!db.objectStoreNames.contains('defects')) {
                    var s = db.createObjectStore('defects', { keyPath: 'key' });
                    s.createIndex('by_updated', 'updated', { unique: false });
                    s.createIndex('by_project', 'project', { unique: false });
                    s.createIndex('by_modelVersion', 'embeddingModelVersion', { unique: false });
                }
                if (!db.objectStoreNames.contains('meta')) {
                    db.createObjectStore('meta', { keyPath: 'k' });
                }
            };
            req.onsuccess = function (e) { JiTA.db._db = e.target.result; resolve(JiTA.db._db); };
            req.onerror = function (e) { reject(e.target.error); };
        });
    },

    _store: function (name, mode) {
        return JiTA.db._db.transaction(name, mode).objectStore(name);
    },

    // Open the DB, run a single IDBRequest built by mkReq(objectStore), and resolve mapRes(request.result)
    // (or undefined when mapRes is omitted). Collapses the identical open->Promise->onsuccess/onerror shape
    // shared by getDefect / allDefects / countDefects / countByProject / getMeta / setMeta.
    _req: function (name, mode, mkReq, mapRes) {
        return JiTA.db.open().then(function () {
            return new Promise(function (resolve, reject) {
                var r = mkReq(JiTA.db._store(name, mode));
                r.onsuccess = function () { resolve(mapRes ? mapRes(r.result) : undefined); };
                r.onerror = function (e) { reject(e.target.error); };
            });
        });
    },

    // Open the DB and run one readwrite transaction that applies `apply(store, item)` to every item, resolving
    // with the item count once the transaction commits. Shared by bulkPut / deleteDefects (empty -> resolve 0).
    _bulkTx: function (items, apply) {
        return JiTA.db.open().then(function (db) {
            return new Promise(function (resolve, reject) {
                if (!items || !items.length) { resolve(0); return; }
                var tx = db.transaction('defects', 'readwrite'), store = tx.objectStore('defects');
                for (var i = 0; i < items.length; i++) { apply(store, items[i]); }
                tx.oncomplete = function () { resolve(items.length); };
                tx.onerror = function (e) { reject(e.target.error); };
            });
        });
    },

    bulkPut: function (recs) { return JiTA.db._bulkTx(recs, function (store, rec) { store.put(rec); }); },

    getDefect: function (key) { return JiTA.db._req('defects', 'readonly', function (s) { return s.get(key); }, function (v) { return v || null; }); },

    allDefects: function () { return JiTA.db._req('defects', 'readonly', function (s) { return s.getAll(); }, function (v) { return v || []; }); },

    countDefects: function () { return JiTA.db._req('defects', 'readonly', function (s) { return s.count(); }, function (v) { return v || 0; }); },

    // Clear the DEFECT records (EDR/EO) only, preserving any stored open bug reports (EBR). Used by the
    // "Rebuild defect database" action, which must not wipe the separately-synced bug-report dataset.
    clearDefects: function () {
        return JiTA.db.allDefects().then(function (recs) {
            var keys = [];
            for (var i = 0; i < recs.length; i++) { if (recs[i].project !== 'EBR') { keys.push(recs[i].key); } }
            return JiTA.db.deleteDefects(keys);
        });
    },

    // Clear ONLY the stored open bug reports (EBR), preserving the defect records. The mirror of
    // clearDefects, used by the "Rebuild BR DB" action.
    clearEbr: function () {
        return JiTA.db.allDefects().then(function (recs) {
            var keys = [];
            for (var i = 0; i < recs.length; i++) { if (recs[i].project === 'EBR') { keys.push(recs[i].key); } }
            return JiTA.db.deleteDefects(keys);
        });
    },

    // Delete records by key (used by the EBR incremental sync to drop reports that have since closed).
    deleteDefects: function (keys) { return JiTA.db._bulkTx(keys, function (store, key) { store.delete(key); }); },

    // Count stored records whose project key === project (e.g. 'EBR'), via the by_project index.
    countByProject: function (project) {
        return JiTA.db._req('defects', 'readonly', function (s) { return s.index('by_project').count(JiTA.db._keyRange().only(project)); }, function (v) { return v || 0; });
    },

    countEbr: function () { return JiTA.db.countByProject('EBR'); },

    // Number of DEFECT records (everything that isn't a bug report). Used by the defect-population checks
    // (sync decisions, "no data yet" messages) so the shared store's EBRs don't make the defect side think
    // it already has data.
    countDefectsOnly: function () {
        return JiTA.db.countDefects().then(function (total) {
            return JiTA.db.countEbr().then(function (ebr) { return total - ebr; });
        });
    },

    getMeta: function (k) { return JiTA.db._req('meta', 'readonly', function (s) { return s.get(k); }, function (v) { return v ? v.v : null; }); },

    setMeta: function (k, v) { return JiTA.db._req('meta', 'readwrite', function (s) { return s.put({ k: k, v: v }); }); }
};


/* ---- sync engine ---- */
JiTA.sync = {
    running: false,

    // POST to a Jira REST endpoint with the session cookie; retries on HTTP 429 honoring Retry-After.
    _apiPost: function (path, body) {
        return new Promise(function (resolve, reject) {
            (function attempt(retries) {
                $.ajax({
                    url: JiTA.HOST + path,
                    type: 'POST',
                    contentType: 'application/json',
                    dataType: 'json',
                    headers: { 'X-Atlassian-Token': 'no-check' },
                    data: JSON.stringify(body)
                }).done(function (data, status, xhr) {
                    resolve({ data: data, xhr: xhr });
                }).fail(function (xhr) {
                    if (xhr.status === 429 && retries > 0) {
                        var ra = parseInt(xhr.getResponseHeader('Retry-After'), 10);
                        var wait = (isNaN(ra) ? 5 : ra) * 1000;
                        setTimeout(function () { attempt(retries - 1); }, wait);
                    } else {
                        reject(new Error('Jira API ' + path + ' failed: HTTP ' + xhr.status));
                    }
                });
            })(JiTA.MAX_RETRIES);
        });
    },

    // Map a raw Jira issue (v2 shape) into a stored defect record.
    _mapIssue: function (issue) {
        var f = issue.fields || {};
        var summary = f.summary || '';
        var description = JiTA.util.toPlainText(f.description);
        var components = [];
        if (f.components) { for (var i = 0; i < f.components.length; i++) { components.push(f.components[i].name); } }
        return {
            key: issue.key,
            project: (f.project && f.project.key) || (issue.key.indexOf('-') > 0 ? issue.key.split('-')[0] : ''),
            summary: summary,
            description: description,
            status: (f.status && f.status.name) || '',
            resolution: (f.resolution && f.resolution.name) || null,
            resolutiondate: f.resolutiondate || null,   // when the defect was fixed/closed (for stale-match demotion)
            created: f.created || null,                  // when the issue was created (shown in the suggestion row)
            components: components,
            updated: f.updated || '',
            team: JiTA.util.teamId(f.customfield_10001),   // Team field; used to exclude GM-team bug reports
            embedding: null,
            embeddingModelVersion: null,
            textHash: JiTA.util.hash(summary + '\n' + description)
        };
    },

    // Page through /search/jql for a given jql, storing each page. Resumable via meta.resumeToken.
    // opts: { startToken, startHighWater, metaPrefix, pruneResolved, isEbr }
    //  - metaPrefix:   suffix for the resume/high-water meta keys so independent datasets (defects vs EBRs)
    //                  keep separate cursors (e.g. 'Ebr' -> resumeTokenEbr / lastSyncHighWaterEbr).
    //  - pruneResolved: DELETE records that come back resolved/closed instead of storing them (used by the
    //                  EBR incremental sync, whose JQL has no open-filter, so reports that have since closed
    //                  are dropped from the open-report set).
    //  - isEbr:        mark the EBR keyword index dirty (not the defect indexes / log-signature index).
    _run: function (jql, opts) {
        opts = opts || {};
        var token = opts.startToken || null;
        var pages = 0, stored = 0;
        var maxUpdated = opts.startHighWater || '';
        var resumeKey = 'resumeToken' + (opts.metaPrefix || '');
        var hwKey = 'lastSyncHighWater' + (opts.metaPrefix || '');

        function nextPage() {
            var body = { jql: jql, fields: JiTA.FIELDS, maxResults: JiTA.PAGE_SIZE };
            if (token) { body.nextPageToken = token; }
            return JiTA.sync._apiPost('/rest/api/3/search/jql', body).then(function (r) {
                var data = r.data || {};
                var issues = data.issues || [];
                var recs = [];
                for (var i = 0; i < issues.length; i++) {
                    var rec = JiTA.sync._mapIssue(issues[i]);
                    if (rec.updated && rec.updated > maxUpdated) { maxUpdated = rec.updated; }
                    recs.push(rec);
                }
                // Preserve existing embeddings for issues whose TEXT did not change, so an incremental
                // re-fetch (or a metadata-only update) does not throw away work the embed pass already did.
                // (For an initial full sync the DB is empty, so these lookups all return null and are cheap.)
                return Promise.all(recs.map(function (rec) {
                    return JiTA.db.getDefect(rec.key).then(function (old) {
                        if (old && old.embedding && old.textHash === rec.textHash) {
                            rec.embedding = old.embedding;
                            rec.embeddingModelVersion = old.embeddingModelVersion;
                        }
                        return rec;
                    });
                })).then(function (merged) {
                    // pruneResolved (EBR incremental sync): split into keep (still open) vs drop (now closed ->
                    // delete from store). Judge closed by STATUS only (isClosedStatus), NOT the resolution field,
                    // so a REOPENED report that kept a stale resolution is kept instead of wrongly pruned.
                    if (opts.pruneResolved) {
                        var keep = [], drop = [];
                        for (var k = 0; k < merged.length; k++) {
                            if (JiTA.util.isClosedStatus(merged[k].status)) { drop.push(merged[k].key); }
                            else { keep.push(merged[k]); }
                        }
                        return JiTA.db.deleteDefects(drop).then(function () { return JiTA.db.bulkPut(keep); });
                    }
                    return JiTA.db.bulkPut(merged);
                }).then(function () {
                    stored += recs.length;
                    pages++;
                    if (opts.isEbr) {
                        JiTA.rank._dirtyEbr = true;      // EBR keyword index depends on EBR records
                        JiTA.rank._dirtyEbrVec = true;   // ...and the EBR vector index (new/removed reports)
                    } else {
                        JiTA.rank._dirty = true;
                        JiTA.rank._dirtyVec = true;
                        if (JiTA.logsig) { JiTA.logsig._dirty = true; }   // re-mine exception signatures on next log open
                    }
                    var nextToken = data.nextPageToken || null;
                    // Persist progress so a reload mid-sync resumes rather than restarting.
                    return JiTA.db.setMeta(resumeKey, (data.isLast || !nextToken) ? null : nextToken)
                        .then(function () { return JiTA.db.setMeta(hwKey, maxUpdated); })
                        .then(function () {
                            JiTA.ui.setStatus('Syncing… ' + stored + ' issues fetched');
                            if (data.isLast || !nextToken) { return { stored: stored, highWater: maxUpdated }; }
                            if (nextToken === token) { throw new Error('nextPageToken did not advance – stopping (Jira API quirk).'); }
                            token = nextToken;
                            var near = (r.xhr.getResponseHeader('X-RateLimit-NearLimit') === 'true');
                            return JiTA.util.delay(near ? JiTA.NEAR_LIMIT_DELAY_MS : JiTA.PAGE_DELAY_MS).then(nextPage);
                        });
                });
            });
        }
        return nextPage();
    },

    fullSync: function () {
        return JiTA.db.getMeta('resumeToken').then(function (rt) {
            return JiTA.db.getMeta('lastSyncHighWater').then(function (hw) {
                var jql = JiTA.SCOPE + ' ORDER BY updated ASC';
                return JiTA.sync._run(jql, { startToken: rt || null, startHighWater: hw || '' }).then(function (res) {
                    // A full crawl re-fetched every defect, so the whole dataset now carries the current field
                    // set - stamp the schema version + build time (read by JiTA.migrate to auto-rebuild a
                    // stale DB, and shown in the settings menu so you can see when the DB was built).
                    return JiTA.db.setMeta('lastFullSyncAt', new Date().toISOString())
                        .then(function () { return JiTA.db.setMeta('modelVersion', JiTA.MODEL_VERSION); })
                        .then(function () { return JiTA.db.setMeta('dataVersionDefects', JiTA.DATA_VERSION); })
                        .then(function () { return JiTA.db.setMeta('dbBuiltAtDefects', new Date().toISOString()); })
                        .then(function () { return res; });
                });
            });
        });
    },

    incrementalSync: function () {
        return JiTA.db.getMeta('lastSyncHighWater').then(function (hw) {
            if (!hw) { return JiTA.sync.fullSync(); }
            var since = JiTA.util.toJqlTime(hw);
            if (!since) { return JiTA.sync.fullSync(); }
            var jql = JiTA.SCOPE + ' AND updated >= "' + since + '" ORDER BY updated ASC';
            return JiTA.sync._run(jql, { startHighWater: hw });
        });
    },

    // Menu entry point: full sync if the DB is empty, otherwise an incremental catch-up.
    syncNow: function () {
        if (JiTA.sync.running) { JiTA.ui.toast('A sync is already running…'); return Promise.resolve(); }
        JiTA.sync.running = true;
        JiTA.ui.toast('Starting defect sync…');
        JiTA.ui.setStatus('Starting sync…');
        return JiTA.db.countDefectsOnly().then(function (n) {
            return n === 0 ? JiTA.sync.fullSync() : JiTA.sync.incrementalSync();
        }).then(function (res) {
            return JiTA.db.countDefectsOnly().then(function (total) {
                JiTA.sync.running = false;
                JiTA.ui.toast('Defect sync complete – ' + total + ' defects in local DB.');
                JiTA.ui.setStatus(total + ' defects in database');
                JiTA.sched.markSynced();   // a manual sync also resets the auto-sync 30-min clock
                if (JiTA.ui.currentKey && /^EBR-/.test(JiTA.ui.currentKey)) { JiTA.ui.scheduleRender(); }   // defect data only affects the EBR (similar defects) view
                JiTA.embed.prepare(true);   // embed new/changed defects in the background (no-op if model unavailable)
                return res;
            });
        }).catch(function (e) {
            JiTA.sync.running = false;
            JiTA.db.setMeta('lastError', String(e && e.message || e));
            JiTA.ui.setStatus('Sync error: ' + (e && e.message || e));
            alert('Defect sync failed: ' + (e && e.message || e) + '\nReport issues to Schogol :).');
        });
    },

    // Wipe the local DB and rebuild from scratch (also used after a model-version change in Phase 2).
    rebuild: function () {
        if (JiTA.sync.running) { JiTA.ui.toast('A sync is already running…'); return Promise.resolve(); }
        if (!confirm('Rebuild the local defect database from scratch? This re-fetches every EDR/EO/PLAT issue.')) { return Promise.resolve(); }
        JiTA.sync.running = true;
        JiTA.ui.toast('Rebuilding defect database…');
        return JiTA.db.clearDefects()
            .then(function () { return JiTA.db.setMeta('resumeToken', null); })
            .then(function () { return JiTA.db.setMeta('lastSyncHighWater', ''); })
            .then(function () { JiTA.rank._dirty = true; return JiTA.sync.fullSync(); })
            .then(function () {
                return JiTA.db.countByProject('EBR').then(function (ebr) {
                  return JiTA.db.countDefects().then(function (total) {
                    JiTA.sync.running = false;
                    JiTA.ui.toast('Rebuild complete – ' + (total - ebr) + ' defects.');   // EBRs are preserved, exclude them from the count
                    JiTA.sched.markSynced();   // a rebuild also resets the auto-sync 30-min clock
                    if (JiTA.ui.currentKey && /^EBR-/.test(JiTA.ui.currentKey)) { JiTA.ui.scheduleRender(); }   // defect data only affects the EBR (similar defects) view
                    JiTA.embed.prepare(true);   // re-embed everything in the background
                  });
                });
            })
            .catch(function (e) {
                JiTA.sync.running = false;
                JiTA.ui.setStatus('Rebuild error: ' + (e && e.message || e));
                alert('Rebuild failed: ' + (e && e.message || e));
            });
    },

    // Wipe ONLY the stored open bug reports and rebuild that dataset from scratch (defects are preserved).
    // The mirror of rebuild() for the EBR side: clear EBR records + their cursors, then a full EBR build.
    // Useful when the open-report set has drifted (closures missed between incremental syncs) and you want
    // a clean re-fetch, since "Sync bug reports now" only ever does an incremental catch-up once populated.
    rebuildEbr: function () {
        if (JiTA.sync.running) { JiTA.ui.toast('A sync is already running…'); return Promise.resolve(); }
        if (!confirm('Rebuild the local bug report database from scratch? This re-fetches every open EBR.')) { return Promise.resolve(); }
        JiTA.sync.running = true;
        JiTA.ui.toast('Rebuilding bug report database…');
        return JiTA.db.clearEbr()
            .then(function () { return JiTA.db.setMeta('resumeTokenEbr', null); })
            .then(function () { return JiTA.db.setMeta('lastSyncHighWaterEbr', ''); })
            .then(function () { JiTA.rank._dirtyEbr = true; JiTA.rank._dirtyEbrVec = true; return JiTA.sync.fullSyncEbr(); })
            .then(function () {
                return JiTA.db.countEbr().then(function (total) {
                    JiTA.sync.running = false;
                    JiTA.ui.toast('Rebuild complete – ' + total + ' open bug reports.');
                    JiTA.sched.markSynced();   // a rebuild also resets the auto-sync 30-min clock
                    if (JiTA.ui.currentKey && JiTA.ui._isReportsKey(JiTA.ui.currentKey)) { JiTA.ui.scheduleRender(); }   // bug-report data only affects the EDR/EO (matching reports) view
                    JiTA.embed.prepare(true);   // re-embed the bug reports in the background
                });
            })
            .catch(function (e) {
                JiTA.sync.running = false;
                JiTA.ui.setStatus('Bug report rebuild error: ' + (e && e.message || e));
                alert('Bug report rebuild failed: ' + (e && e.message || e));
            });
    },

    // Re-crawl a whole dataset from scratch WITHOUT clearing it first (unlike rebuild). Resetting the cursors
    // forces a full crawl; because the existing records stay put, _run's "preserve embedding when textHash is
    // unchanged" path keeps every vector while bulkPut overwrites each record with the current field set - so
    // a newly-added field (e.g. `created`) is backfilled with NO re-embedding. Used by JiTA.migrate to
    // upgrade a DB built before a field existed. Single-flight via `running`; quiet (no confirm dialog).
    refetchDefects: function () {
        if (JiTA.sync.running) { return Promise.resolve(); }
        JiTA.sync.running = true;
        JiTA.ui.toast('Updating local defect database to the latest format…');
        return JiTA.db.setMeta('resumeToken', null)
            .then(function () { return JiTA.db.setMeta('lastSyncHighWater', ''); })
            .then(function () { JiTA.rank._dirty = true; JiTA.rank._dirtyVec = true; return JiTA.sync.fullSync(); })
            .then(function () {
                return JiTA.db.countDefectsOnly().then(function (total) {
                    JiTA.sync.running = false;
                    JiTA.ui.toast('Defect database updated – ' + total + ' defects.');
                    JiTA.sched.markSynced();
                    if (JiTA.ui.currentKey && /^EBR-/.test(JiTA.ui.currentKey)) { JiTA.ui.scheduleRender(); }
                    JiTA.embed.prepare(true);
                });
            })
            .catch(function (e) {
                JiTA.sync.running = false;
                console.log('[JiTA] defect refetch (migration) failed:', e && e.message || e);
            });
    },

    refetchEbr: function () {
        if (JiTA.sync.running) { return Promise.resolve(); }
        JiTA.sync.running = true;
        JiTA.ui.toast('Updating local bug report database to the latest format…');
        return JiTA.db.setMeta('resumeTokenEbr', null)
            .then(function () { return JiTA.db.setMeta('lastSyncHighWaterEbr', ''); })
            .then(function () { JiTA.rank._dirtyEbr = true; JiTA.rank._dirtyEbrVec = true; return JiTA.sync.fullSyncEbr(); })
            .then(function () {
                return JiTA.db.countEbr().then(function (total) {
                    JiTA.sync.running = false;
                    JiTA.ui.toast('Bug report database updated – ' + total + ' open reports.');
                    JiTA.sched.markSynced();
                    if (JiTA.ui.currentKey && JiTA.ui._isReportsKey(JiTA.ui.currentKey)) { JiTA.ui.scheduleRender(); }
                    JiTA.embed.prepare(true);
                });
            })
            .catch(function (e) {
                JiTA.sync.running = false;
                console.log('[JiTA] bug report refetch (migration) failed:', e && e.message || e);
            });
    },

    // ---- open bug reports (EBR) sync, for the EDR "matching reports" view ----
    // Same paging engine as the defects, but its own meta cursors (resumeTokenEbr / lastSyncHighWaterEbr)
    // and the EBR keyword index as the dirty target. The FULL build uses the open-only scope; the
    // INCREMENTAL pass drops the open-filter and prunes (deletes) reports that have since closed.
    fullSyncEbr: function () {
        return JiTA.db.getMeta('resumeTokenEbr').then(function (rt) {
            return JiTA.db.getMeta('lastSyncHighWaterEbr').then(function (hw) {
                var jql = JiTA.EBR_SCOPE + ' ORDER BY updated ASC';
                return JiTA.sync._run(jql, { startToken: rt || null, startHighWater: hw || '', metaPrefix: 'Ebr', isEbr: true }).then(function (res) {
                    // Full open-EBR crawl -> stamp the EBR schema version + build time (see fullSync / JiTA.migrate).
                    return JiTA.db.setMeta('dataVersionEbr', JiTA.DATA_VERSION)
                        .then(function () { return JiTA.db.setMeta('dbBuiltAtEbr', new Date().toISOString()); })
                        .then(function () { return res; });
                });
            });
        });
    },

    incrementalSyncEbr: function () {
        return JiTA.db.getMeta('lastSyncHighWaterEbr').then(function (hw) {
            if (!hw) { return JiTA.sync.fullSyncEbr(); }
            var since = JiTA.util.toJqlTime(hw);
            if (!since) { return JiTA.sync.fullSyncEbr(); }
            // No open-filter here on purpose: we want updated-but-now-closed reports back so pruneResolved
            // can delete them from the open-report set.
            var jql = 'project = EBR AND updated >= "' + since + '" ORDER BY updated ASC';
            return JiTA.sync._run(jql, { startHighWater: hw, metaPrefix: 'Ebr', pruneResolved: true, isEbr: true });
        });
    },

    // Menu entry point for the bug-report dataset: full build if empty, otherwise an incremental catch-up.
    syncEbrNow: function () {
        if (JiTA.sync.running) { JiTA.ui.toast('A sync is already running…'); return Promise.resolve(); }
        JiTA.sync.running = true;
        JiTA.ui.toast('Starting bug report sync…');
        JiTA.ui.setStatus('Starting bug report sync…');
        return JiTA.db.countEbr().then(function (n) {
            return n === 0 ? JiTA.sync.fullSyncEbr() : JiTA.sync.incrementalSyncEbr();
        }).then(function () {
            return JiTA.db.countEbr().then(function (total) {
                JiTA.sync.running = false;
                JiTA.rank._dirtyEbr = true;
                JiTA.rank._dirtyEbrVec = true;
                JiTA.ui.toast('Bug report sync complete – ' + total + ' open reports in local DB.');
                JiTA.sched.markSynced();   // a manual sync also resets the auto-sync 30-min clock
                if (JiTA.ui.currentKey && JiTA.ui._isReportsKey(JiTA.ui.currentKey)) { JiTA.ui.scheduleRender(); }
                JiTA.embed.prepare(true);   // embed the new/changed bug reports in the background (for hybrid)
            });
        }).catch(function (e) {
            JiTA.sync.running = false;
            JiTA.db.setMeta('lastError', String(e && e.message || e));
            JiTA.ui.setStatus('Bug report sync error: ' + (e && e.message || e));
            alert('Bug report sync failed: ' + (e && e.message || e) + '\nReport issues to Schogol :).');
        });
    },

    // Menu entry point for the single "Sync now" button: sync the defect dataset, then the bug-report
    // dataset, sequentially (each is single-flight via `running`, so we chain them). Each leg shows its own
    // toast / status as before. Guarded up front so a click while a sync is running is a no-op + toast.
    syncAllNow: function () {
        if (JiTA.sync.running) { JiTA.ui.toast('A sync is already running…'); return Promise.resolve(); }
        return JiTA.sync.syncNow().then(function () { return JiTA.sync.syncEbrNow(); });
    },

    // Quiet background catch-up used by the auto-sync scheduler. BOTH datasets AUTO-INITIALIZE on the first
    // run (full build when the DB is empty) and then run incremental catch-ups: DEFECTS (EDR/EO) and OPEN
    // BUG REPORTS (EBRs). No start/finish toasts; re-embeds / refreshes the open panel only on actual changes.
    autoSync: function () {
        if (JiTA.sync.running) { return Promise.resolve(); }
        JiTA.sync.running = true;
        var defectStored = 0, ebrChanged = false;
        return JiTA.db.countDefectsOnly().then(function (n) {
            // Auto-initialize the defect DB on the first run (full build), then incremental catch-up.
            var run = (n === 0) ? JiTA.sync.fullSync() : JiTA.sync.incrementalSync();
            return run.then(function (res) { defectStored = (res && res.stored) || 0; });
        }).then(function () {
            return JiTA.db.countEbr().then(function (m) {
                // First run with no reports yet -> initialize the open-report DB once; otherwise catch up.
                var run = (m === 0) ? JiTA.sync.fullSyncEbr() : JiTA.sync.incrementalSyncEbr();
                return run.then(function (res) { if (m === 0 || (res && res.stored)) { ebrChanged = true; } });
            });
        }).then(function () {
            JiTA.sync.running = false;
            console.log('[JiTA] auto-sync done (defects ' + defectStored + ' fetched; EBRs ' + (ebrChanged ? 'updated' : 'unchanged') + ')');
            return JiTA.db.setMeta('lastAutoSyncAt', new Date().toISOString()).then(function () {
                JiTA.sched.markSynced();   // start the 30-min clock so reloads don't re-fetch
                if (defectStored > 0 || ebrChanged) { JiTA.embed.prepare(true); }   // embed any new/changed defects AND bug reports
                if (defectStored > 0 && JiTA.ui.currentKey && /^EBR-/.test(JiTA.ui.currentKey)) { JiTA.ui.scheduleRender(); }
                if (ebrChanged && JiTA.ui.currentKey && JiTA.ui._isReportsKey(JiTA.ui.currentKey)) { JiTA.ui.scheduleRender(); }
            });
        }).catch(function (e) {
            JiTA.sync.running = false;
            JiTA.db.setMeta('lastError', String(e && e.message || e));
            console.log('[JiTA] auto-sync error:', e && e.message || e);
        });
    }
};


/* ---- ranking: BM25 keyword similarity (Phase 1) ---- */
JiTA.rank = {
    _index: null,       // { N, avgdl, df:{}, docs:[{key,project,summary,status,tf:{},len}] }
    _dirty: true,       // set true whenever sync writes; triggers a rebuild on next query
    _building: null,
    _ebrIndex: null,    // same shape, built over OPEN EBRs only (for the EDR "matching reports" view)
    _dirtyEbr: true,    // set true whenever the EBR sync writes; triggers an EBR index rebuild on next query
    _buildingEbr: null,
    K1: 1.5,
    B: 0.75,
    STOP: (function () {
        var s = {}, w = ('the a an and or of to in for on with is are was were be been it this that these those as at by from we you they i he she his her its their our your not no but if then than so such can will would should could may might do does did has have had into over under out up down off about your yours'.split(' '));
        for (var i = 0; i < w.length; i++) { s[w[i]] = true; }
        return s;
    })(),

    _tokenize: function (text) {
        var raw = (text || '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').split(/\s+/);
        var out = [];
        for (var i = 0; i < raw.length; i++) {
            var t = raw[i];
            if (t.length >= 2 && !JiTA.rank.STOP[t]) { out.push(t); }
        }
        return out;
    },

    // True when `hay` (a doc's lowercased key+summary+description) contains EVERY term. Drives the filter box,
    // which restricts the ranked corpus to issues matching the typed text before TOP_N is taken.
    _matchTerms: function (hay, terms) {
        if (!terms || !terms.length) { return true; }
        if (!hay) { return false; }
        for (var i = 0; i < terms.length; i++) { if (hay.indexOf(terms[i]) === -1) { return false; } }
        return true;
    },

    // Single-flight cache wrapper shared by all four index builders: return the cached index when present and
    // not dirty; coalesce concurrent builds onto one in-flight promise; otherwise rebuild from allDefects() via
    // build(records), clearing the dirty flag on success and the in-flight slot on both paths. State lives in
    // the named rank properties passed as string keys (e.g. '_index' / '_dirty' / '_building').
    _ensureCached: function (indexKey, dirtyKey, buildingKey, build) {
        var R = JiTA.rank;
        if (R[indexKey] && !R[dirtyKey]) { return Promise.resolve(R[indexKey]); }
        if (R[buildingKey]) { return R[buildingKey]; }
        R[buildingKey] = JiTA.db.allDefects().then(function (records) {
            R[indexKey] = build(records);
            R[dirtyKey] = false;
            R[buildingKey] = null;
            return R[indexKey];
        }).catch(function (e) { R[buildingKey] = null; throw e; });
        return R[buildingKey];
    },

    _ensureIndex: function () {
        return JiTA.rank._ensureCached('_index', '_dirty', '_building', function (records) {
            return JiTA.rank._buildKeywordIndex(records, function (rec) { return rec.project !== 'EBR'; });
        });
    },

    // Rank stored defects against the query text. Returns up to `limit` (default TOP_N) scored results.
    suggest: function (text, excludeKey, limit, filterTerms) {
        return JiTA.rank._ensureIndex().then(function (idx) {
            return JiTA.rank._bm25Score(idx, text, excludeKey, limit, filterTerms);
        });
    },

    // Build (and cache) a BM25 index over the OPEN bug reports (project EBR) stored in the same DB. Same
    // shape and tokenizer as the defect index; closed reports are skipped defensively (the EBR sync prunes
    // them, but a stale record could linger between syncs).
    _ensureEbrIndex: function () {
        return JiTA.rank._ensureCached('_ebrIndex', '_dirtyEbr', '_buildingEbr', function (records) {
            return JiTA.rank._buildKeywordIndex(records, function (rec) { return rec.project === 'EBR' && !JiTA.util.isClosedStatus(rec.status) && !JiTA.util.isGmTeam(rec.team); });
        });
    },

    // Rank OPEN bug reports against the query text (a defect's text). Returns up to `limit` scored results,
    // each with a display `pct` relative to the top score. Mirrors `suggest` but over the EBR index.
    suggestEbr: function (text, excludeKey, limit, filterTerms) {
        return JiTA.rank._ensureEbrIndex().then(function (idx) {
            var scored = JiTA.rank._bm25Score(idx, text, excludeKey, limit, filterTerms);
            var top = (scored[0] && scored[0].score) || 0;
            for (var p = 0; p < scored.length; p++) { scored[p].pct = top > 0 ? Math.round(scored[p].score / top * 100) : 0; }
            return scored;
        });
    }
};

// Shared body of the two keyword indexes (_ensureIndex / _ensureEbrIndex). `keep(rec)` selects which records
// go in (defects = non-EBR; open reports = EBR & not closed). Returns { N, avgdl, df, docs } - identical shape
// and tokenizer for both, so BM25 ranks the same over either corpus.
JiTA.rank._buildKeywordIndex = function (records, keep) {
    var df = {}, docs = [], totalLen = 0;
    for (var i = 0; i < records.length; i++) {
        var rec = records[i];
        if (!keep(rec)) { continue; }
        var toks = JiTA.rank._tokenize(JiTA.util.cleanForCompare(rec.summary, rec.description));
        var tf = {}, seen = {};
        for (var j = 0; j < toks.length; j++) {
            var tk = toks[j];
            tf[tk] = (tf[tk] || 0) + 1;
            if (!seen[tk]) { df[tk] = (df[tk] || 0) + 1; seen[tk] = true; }
        }
        totalLen += toks.length;
        docs.push({ key: rec.key, project: rec.project, summary: rec.summary, status: rec.status, resolution: rec.resolution, resolutiondate: rec.resolutiondate, created: rec.created, tf: tf, len: toks.length, hay: ((rec.key || '') + ' ' + (rec.summary || '') + ' ' + (rec.description || '')).toLowerCase() });
    }
    return { N: docs.length, avgdl: docs.length ? (totalLen / docs.length) : 0, df: df, docs: docs };
};

// Shared BM25 scoring loop for suggest / suggestEbr. Tokenizes the query, computes idf over `idx`, then scores
// every doc that passes the exclude-key / hidden / filter-box / session-filter gates. Returns up to `limit`
// results sorted best-first (no display pct - suggestEbr layers its own top-relative pct on the result). A
// filter-box match with no query-term overlap is still kept as a score-0 candidate (matches the original).
JiTA.rank._bm25Score = function (idx, text, excludeKey, limit, filterTerms) {
    if (!idx || !idx.N) { return []; }
    var qTokens = JiTA.rank._tokenize(text);
    var qSet = {};
    for (var i = 0; i < qTokens.length; i++) { qSet[qTokens[i]] = true; }
    var terms = Object.keys(qSet);
    if (!terms.length) { return []; }
    var k1 = JiTA.rank.K1, b = JiTA.rank.B, avgdl = idx.avgdl || 1;
    var idf = {};
    for (var t = 0; t < terms.length; t++) {
        var n = idx.df[terms[t]] || 0;
        idf[terms[t]] = Math.log(1 + (idx.N - n + 0.5) / (n + 0.5));
    }
    var scored = [];
    for (var d = 0; d < idx.docs.length; d++) {
        var doc = idx.docs[d];
        if (excludeKey && doc.key === excludeKey) { continue; }
        if (JiTA.hidden.isHidden(doc.key)) { continue; }   // user-hidden suggestion (temporary, persisted across updates)
        if (filterTerms && filterTerms.length && !JiTA.rank._matchTerms(doc.hay, filterTerms)) { continue; }   // filter box: restrict the whole corpus
        if (!JiTA.ui.passesFilter(doc)) { continue; }   // session filters (status / recency)
        var score = 0;
        for (var q = 0; q < terms.length; q++) {
            var tf = doc.tf[terms[q]];
            if (!tf) { continue; }
            var denom = tf + k1 * (1 - b + b * (doc.len / avgdl));
            score += idf[terms[q]] * (tf * (k1 + 1)) / denom;
        }
        if (score > 0) { scored.push({ key: doc.key, project: doc.project, summary: doc.summary, status: doc.status, resolution: doc.resolution, resolutiondate: doc.resolutiondate, score: score }); }
        else if (filterTerms && filterTerms.length) { scored.push({ key: doc.key, project: doc.project, summary: doc.summary, status: doc.status, resolution: doc.resolution, resolutiondate: doc.resolutiondate, score: 0 }); }   // filter match with no issue-text overlap - still a candidate
    }
    scored.sort(function (a, c) { return c.score - a.score; });
    return scored.slice(0, limit || JiTA.TOP_N);
};


/* ---- embedding engine: local transformers.js (Phase 2) ----
 * Lazily loads a small sentence-embedding model in the browser (no server, no API key) and embeds
 * defect text into 384-dim normalized vectors. CSP on this instance is permissive (only frame-ancestors,
 * WASM OK), so we load the library with a plain dynamic import() of a pinned CDN ESM build and let it
 * fetch model weights directly. Any failure flips `unavailable` and the ranking layer falls back to BM25.
 */
JiTA.embed = {
    MODEL: 'Xenova/gte-small',   // English, retrieval-tuned, 384-dim (better recall than all-MiniLM for dup-finding)
    LIB_URL: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.2/dist/transformers.min.js',
    BATCH: 16,
    MAX_CHARS: 1500,            // cap text per issue. Now that cleanForCompare strips the boilerplate, the
                                // budget holds real content; raised back to 1500 (~380 tokens) since GPU
                                // fp32/batch-32 handles it fast. (On the CPU fallback this is slower but the
                                // single-item path + watchdog keep it safe.)
    WARM_WAIT_MS: 4200,        // on first render, how long the panel waits for the model to finish loading
                               // before falling back to instant keyword results (fast/no-op when cached)
    ready: false,              // model pipeline is loaded and usable
    unavailable: false,        // load failed irrecoverably -> stay on BM25
    backend: null,             // 'webgpu/fp16' etc (for diagnostics)
    _cpuFallback: false,       // set after a GPU device loss -> rebuild on WASM only
    _pipe: null,
    _loading: null,
    _preparing: null,
    _prepared: false,

    // Drop the current pipeline so the next embed call rebuilds it (used to recover from a lost GPU device).
    _resetPipe: function () {
        JiTA.embed._pipe = null;
        JiTA.embed._loading = null;
        JiTA.embed.ready = false;
    },

    // Load (once) the transformers.js pipeline. Resolves to the pipeline, or rejects and sets `unavailable`.
    // Inference is kept OFF the main thread so the Jira tab never freezes: WebGPU runs on the GPU, and the
    // WASM fallback runs in its own worker via env.backends.onnx.wasm.proxy. We pick WebGPU if it actually
    // works (validated with a tiny warmup) and otherwise fall back to WASM.
    load: function () {
        if (JiTA.embed._pipe) { return Promise.resolve(JiTA.embed._pipe); }
        if (JiTA.embed.unavailable) { return Promise.reject(new Error('embeddings unavailable')); }
        if (JiTA.embed._loading) { return JiTA.embed._loading; }
        JiTA.embed._loading = (function () {
            return import(JiTA.embed.LIB_URL).then(function (mod) {
                if (mod.env) {
                    mod.env.allowLocalModels = false;     // always fetch from the hub/CDN
                    mod.env.useBrowserCache = true;        // cache weights in CacheStorage after first download
                    // Run the ONNX/WASM backend in a worker so embedding never blocks the page.
                    try { mod.env.backends.onnx.wasm.proxy = true; } catch (e) { /* older builds: ignore */ }
                }
                // Pick a backend that actually works. We deliberately do NOT use fp16 on WebGPU for this
                // model: gte-small's intermediate activations exceed the tiny fp16 range and overflow to
                // Inf/NaN, so embeddings come back as NaN (cosine -> NaN, "%" shows NaN, semantic ranking
                // becomes noise). fp32 on WebGPU is reliable; the WASM/CPU fallback uses q8 (small + fine on
                // CPU). Each candidate is validated below, so any backend that yields bad numbers is rejected.
                // After a GPU device loss we rebuild on WASM only; otherwise prefer WebGPU fp32 then WASM.
                // WebGPU has proven unstable for this model: every dtype/batch size we tried eventually died
                // with a device loss ("AbortError: Buffer unmapped") that can even HANG the worker - the
                // batch promise never resolves or rejects, so the CPU fallback never triggers and the pass
                // silently stalls. So the default is CPU/WASM only: slower but rock-solid and finite (no fp16
                // NaN issues either). WebGPU is the DEFAULT backend (fast): `sdTryWebgpu` defaults to true and
                // the menu toggle is the ONLY thing that switches backend - a GPU failure does NOT auto-fall
                // back to CPU (it retries on GPU, then pauses). `sdForceCpu` is still honored if the menu sets
                // it, but the embed/query paths no longer set it themselves.
                var forceCpu = JiTA.embed._cpuFallback || gmGet('sdForceCpu', false);
                var tryGpu = !forceCpu && gmGet('sdTryWebgpu', true);
                var attempts = tryGpu
                    ? [{ device: 'webgpu', dtype: 'fp32' }, { device: 'wasm', dtype: 'q8' }]
                    : [{ device: 'wasm', dtype: 'q8' }];
                function buildWith(opts) {
                    // Validate with a realistic, longer input rather than a single word. fp16/overflow issues
                    // surface only on real-length text, so a tiny warmup would falsely "pass" and we'd store
                    // NaN vectors. Require a finite, properly-normalized vector (sum of squares ~= 1).
                    return mod.pipeline('feature-extraction', JiTA.embed.MODEL, opts).then(function (pipe) {
                        var probe = 'The quick brown fox jumps over the lazy dog. ' +
                            'Client crashes on undock with an access violation in the rendering thread after the latest patch.';
                        return pipe(probe, { pooling: 'mean', normalize: true }).then(function (out) {
                            var d = out && out.data, ss = 0, ok = !!(d && d.length);
                            for (var i = 0; ok && i < d.length; i++) {
                                if (!isFinite(d[i])) { ok = false; } else { ss += d[i] * d[i]; }
                            }
                            if (!ok || !(ss > 0.5)) { throw new Error('backend produced invalid embeddings (NaN/Inf/zero)'); }
                            return pipe;
                        });
                    });
                }
                function tryFrom(i) {
                    if (i >= attempts.length) { return Promise.reject(new Error('no usable embedding backend')); }
                    return buildWith(attempts[i]).then(function (pipe) {
                        JiTA.embed.backend = attempts[i].device + '/' + attempts[i].dtype;
                        // fp32 GPU memory ~ batch x sequence-length. With MAX_CHARS at 1500, a large batch can
                        // exhaust VRAM and trigger a device loss (the "BindGroup '...' is invalid" cascade), so
                        // WebGPU uses a conservative 8. CPU/WASM runs one at a time: batched (array) inference
                        // hangs the worker there, while the single-string path (same shape as the warmup) is reliable.
                        JiTA.embed.BATCH = (attempts[i].device === 'webgpu') ? 8 : 1;
                        return pipe;
                    }, function () {
                        return tryFrom(i + 1);
                    });
                }
                return tryFrom(0);
            }).then(function (pipe) {
                JiTA.embed._pipe = pipe;
                JiTA.embed.ready = true;
                console.log('[JiTA] embedding model ready (backend: ' + JiTA.embed.backend + ')');
                return pipe;
            });
        })().catch(function (e) {
            JiTA.embed.unavailable = true;
            JiTA.embed._loading = null;
            console.log('[JiTA] embedding model unavailable, using keyword ranking. Reason:', e && e.message || e);
            throw e;
        });
        return JiTA.embed._loading;
    },

    // Embed a single text -> normalized Float32Array(384). Delegates to embedBatch, whose single-item path is
    // the identical plain-string call (same input clamping + shape).
    embedOne: function (text) {
        return JiTA.embed.embedBatch([text]).then(function (vecs) { return vecs[0]; });
    },

    // Embed an array of texts -> array of normalized Float32Array(384).
    embedBatch: function (texts) {
        return JiTA.embed.load().then(function (pipe) {
            var inputs = texts.map(function (t) { return (t || ' ').slice(0, JiTA.embed.MAX_CHARS) || ' '; });
            // Single item: use the plain-string call - the exact shape the warmup proves works. On CPU/WASM
            // here, passing an array (batched, padded) inference hangs the worker, but single strings are fine.
            if (inputs.length === 1) {
                return pipe(inputs[0], { pooling: 'mean', normalize: true }).then(function (out) {
                    return [new Float32Array(out.data)];
                });
            }
            return pipe(inputs, { pooling: 'mean', normalize: true }).then(function (out) {
                var dim = out.dims[out.dims.length - 1];
                var vecs = [];
                for (var i = 0; i < inputs.length; i++) {
                    vecs.push(new Float32Array(out.data.subarray(i * dim, (i + 1) * dim)));
                }
                return vecs;
            });
        });
    },

    // Embed every stored defect that lacks a current-version embedding, in batches, persisting as we go.
    // Resumable: if interrupted, the next run just continues with whatever is still missing.
    embedPass: function () {
        return JiTA.embed.load().then(function () {
            return JiTA.db.allDefects();
        }).then(function (recs) {
            var todo = [], curVer = 0;
            for (var i = 0; i < recs.length; i++) {
                // Embed BOTH defects and open bug reports (EBRs): hybrid ranking is used on both the EBR
                // (similar defects) and EDR (matching reports) views. Skip closed EBRs and GM-team EBRs - neither
                // is ranked in the "matching reports" view, so embedding them is wasted work.
                if (recs[i].project === 'EBR' && (JiTA.util.isClosedStatus(recs[i].status) || JiTA.util.isGmTeam(recs[i].team))) { continue; }
                if (recs[i].embedding && recs[i].embeddingModelVersion === JiTA.MODEL_VERSION) { curVer++; }
                else { todo.push(recs[i]); }
            }
            console.log('[JiTA] embed pass: ' + todo.length + ' to embed, ' + curVer + ' already at ' +
                JiTA.MODEL_VERSION + ' (of ' + recs.length + ' total, backend ' + JiTA.embed.backend + ')');
            if (!todo.length) { JiTA.ui.setStatus('Embeddings up to date (' + curVer + ')'); return; }
            JiTA.ui.toast('Embedding ' + todo.length + ' issues locally…');
            var idx = 0, gpuRetries = 0;
            function nextBatch() {
                if (idx >= todo.length) { console.log('[JiTA] embed pass complete (' + todo.length + ' embedded)'); JiTA.rank._dirtyVec = true; JiTA.rank._dirtyEbrVec = true; return Promise.resolve(); }
                var size = JiTA.embed.BATCH;
                var slice = todo.slice(idx, idx + size);
                var texts = slice.map(function (r) { return JiTA.util.cleanForCompare(r.summary, r.description); });
                // Watchdog: a WebGPU device loss can HANG the worker so embedBatch never resolves OR rejects,
                // which would silently stall the whole pass. Race it against a timeout so a hung batch is
                // treated as a failure and handled by the catch below (retry on the same backend, then pause).
                var t0 = Date.now();
                var batchVecs = JiTA.embed.embedBatch(texts);
                var watchdog = new Promise(function (_resolve, reject) {
                    setTimeout(function () { reject(new Error('embed batch timed out after 45s')); }, 45000);
                });
                return Promise.race([batchVecs, watchdog]).then(function (vecs) {
                    var dt = Date.now() - t0;
                    // Guard against a SILENT device loss: WebGPU can log "BindGroup is invalid" validation
                    // errors yet still resolve the batch with NaN/empty vectors. Storing those would mark the
                    // defect "done" with a garbage embedding (then dropped at query time -> silently never
                    // matches). Detect it and throw, so the catch below recovers (-> CPU) and retries the slice.
                    for (var g = 0; g < vecs.length; g++) {
                        if (!vecs[g] || vecs[g].length === 0 || !isFinite(vecs[g][0])) {
                            throw new Error('embedding returned NaN/empty (likely GPU device loss)');
                        }
                    }
                    for (var j = 0; j < slice.length; j++) {
                        slice[j].embedding = vecs[j];
                        slice[j].embeddingModelVersion = JiTA.MODEL_VERSION;
                    }
                    return JiTA.db.bulkPut(slice).then(function () {
                        idx += slice.length;   // advance by what we actually embedded
                        JiTA.rank._dirtyVec = true;
                        JiTA.rank._dirtyEbrVec = true;
                        // Log throughput periodically so we can see the real CPU speed (first item always logs).
                        if (idx <= slice.length || idx % 50 === 0) {
                            console.log('[JiTA] embedded ' + idx + '/' + todo.length + ' (' + size + ' in ' + dt + 'ms, ' + JiTA.embed.backend + ')');
                        }
                        JiTA.ui.setStatus('Embedding… ' + Math.min(idx, todo.length) + '/' + todo.length + ' (' + JiTA.embed.backend + ')');
                        return JiTA.util.delay(0).then(nextBatch);   // yield to keep the UI responsive
                    });
                }).catch(function (e) {
                    // A batch failed (on WebGPU, usually a device loss). We deliberately do NOT auto-switch to
                    // CPU - the backend is the user's choice via the Tampermonkey menu. idx is NOT advanced, so
                    // no progress is lost: retry a few times on the SAME backend to ride out a transient blip,
                    // and if it keeps failing, pause the pass (it resumes on the next reload / scheduled sync)
                    // and tell the user they can switch backend from the menu.
                    console.log('[JiTA] embed batch failed (' + JiTA.embed.backend + ', size ' + size + '):', e && e.message || e);
                    JiTA.embed._resetPipe();
                    gpuRetries++;
                    if (gpuRetries <= 3) {
                        return JiTA.util.delay(1500).then(nextBatch);
                    }
                    JiTA.ui.toast('Embedding keeps failing on ' + (JiTA.embed.backend || 'GPU') + ' - paused. Reload to retry, or switch backend from the Tampermonkey menu.');
                    throw e;   // give up this pass (progress saved; ranking stays on BM25 meanwhile)
                });
            }
            return nextBatch();
        });
    },

    // Background entry point: load the model and embed anything outstanding, then refresh the panel.
    // Idempotent per session unless `force` is passed (used right after a sync brings in new/changed text).
    prepare: function (force) {
        if (JiTA.embed.unavailable) { return Promise.resolve(); }
        if (JiTA.embed._preparing) { return JiTA.embed._preparing; }
        if (JiTA.embed._prepared && !force) { return Promise.resolve(); }
        JiTA.embed._preparing = JiTA.db.countDefects().then(function (n) {
            if (!n) { return; }   // nothing synced yet (no defects AND no bug reports) - don't download a model
            return JiTA.embed.embedPass().then(function () {
                JiTA.embed._prepared = true;
                JiTA.rank._dirtyVec = true;
                JiTA.rank._dirtyEbrVec = true;
                // Refresh whichever view is open (coalesced, so a sync + this embed-pass completion collapse
                // into a single list rebuild instead of thrashing): EBR -> similar defects, EDR -> reports.
                JiTA.ui.scheduleRender();
            });
        }).then(function () {
            JiTA.embed._preparing = null;
        }).catch(function (e) {
            JiTA.embed._preparing = null;
            console.log('[JiTA] embed prepare skipped:', e && e.message || e);
        });
        return JiTA.embed._preparing;
    }
};


/* ---- semantic ranking (Phase 2): cosine over stored embeddings, with BM25 fallback ---- */
JiTA.rank._vecIndex = null;     // cached array of { key, project, summary, status, resolution, vec }
JiTA.rank._dirtyVec = true;     // rebuild the in-memory vector cache on next semantic query
JiTA.rank._buildingVec = null;

// Shared body of the two vector indexes (_ensureVecIndex / _ensureEbrVecIndex): the current-model embedded
// docs, filtered by `keep` (defects = non-EBR; open reports = EBR & not closed). resolutiondate is carried
// uniformly (unused on the EBR side, harmless).
JiTA.rank._buildVecIndex = function (records, keep) {
    var docs = [];
    for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (!keep(r)) { continue; }
        if (r.embedding && r.embeddingModelVersion === JiTA.MODEL_VERSION) {
            docs.push({ key: r.key, project: r.project, summary: r.summary, status: r.status, resolution: r.resolution, resolutiondate: r.resolutiondate, created: r.created, vec: r.embedding, hay: ((r.key || '') + ' ' + (r.summary || '') + ' ' + (r.description || '')).toLowerCase() });
        }
    }
    return docs;
};

// Build (and cache) the in-memory list of DEFECT vectors for the current model version.
JiTA.rank._ensureVecIndex = function () {
    return JiTA.rank._ensureCached('_vecIndex', '_dirtyVec', '_buildingVec', function (recs) {
        return JiTA.rank._buildVecIndex(recs, function (r) { return r.project !== 'EBR'; });
    });
};

// Cosine similarity of two normalized vectors == dot product.
JiTA.rank._dot = function (a, b) {
    var s = 0, n = Math.min(a.length, b.length);
    for (var i = 0; i < n; i++) { s += a[i] * b[i]; }
    return s;
};

JiTA.rank.CAND = 50;     // candidates pulled from each retriever before fusion
JiTA.rank.RRF_K = 60;    // Reciprocal-Rank-Fusion constant (standard default)

// Fuse a semantic candidate list and a BM25 candidate list into the final TOP_N results via Reciprocal Rank
// Fusion. RRF decides WHICH results make the cut (so strong keyword hits aren't lost even when their cosine
// is middling); the kept rows are then presented sorted by the displayed cosine % so the panel reads high to
// low. `demote` (optional, defect side only) is applied to each fused row before the cut, age-demoting stale
// closed matches (it lowers both rrf and pct, so they fall in the cut AND read lower). Returns the TOP_N array.
JiTA.rank._fuse = function (sem, bm, demote) {
    var K = JiTA.rank.RRF_K;
    var rrf = {}, meta = {}, cosByKey = {};
    var semTop = sem.slice(0, JiTA.rank.CAND);
    for (var i = 0; i < semTop.length; i++) { rrf[semTop[i].key] = (rrf[semTop[i].key] || 0) + 1 / (K + i); meta[semTop[i].key] = semTop[i]; }
    for (var j = 0; j < bm.length; j++) { rrf[bm[j].key] = (rrf[bm[j].key] || 0) + 1 / (K + j); if (!meta[bm[j].key]) { meta[bm[j].key] = bm[j]; } }
    for (var c = 0; c < sem.length; c++) { cosByKey[sem[c].key] = sem[c].score; }   // cosine for display (all docs)
    var out = Object.keys(rrf).map(function (k) {
        var m = meta[k];
        var hasCos = (cosByKey[k] !== undefined && isFinite(cosByKey[k]));
        return {
            key: k, project: m.project, summary: m.summary, status: m.status, resolution: m.resolution,
            resolutiondate: m.resolutiondate,
            rrf: rrf[k], pct: hasCos ? Math.round(Math.max(0, Math.min(1, cosByKey[k])) * 100) : 0
        };
    });
    if (demote) { for (var s = 0; s < out.length; s++) { demote(out[s]); } }
    out.sort(function (a, c2) { return c2.rrf - a.rrf; });
    var topN = out.slice(0, JiTA.TOP_N);
    topN.sort(function (a, c2) { return c2.pct - a.pct; });
    return topN;
};

// Embed the query text, caching the most recent (text -> vector) so filter-box keystrokes (which re-rank the
// SAME issue text against a changing filter) don't re-run the transformer every time - only the filter +
// scoring re-run, not the expensive inference.
JiTA.rank._qvText = null;
JiTA.rank._qvVec = null;
JiTA.rank._embedQuery = function (text) {
    if (JiTA.rank._qvText === text && JiTA.rank._qvVec) { return Promise.resolve(JiTA.rank._qvVec); }
    return JiTA.embed.embedOne(text).then(function (qv) {
        JiTA.rank._qvText = text; JiTA.rank._qvVec = qv; return qv;
    });
};

// Cosine-score every doc from `indexGetter()` (a Promise of a vec index) against the query vector, applying
// the exclude / hidden / filter-box / session-filter gates, sorted best-first. [] if none embedded. Shared by
// the defect and open-EBR semantic scorers (identical loop; resolutiondate is carried uniformly - unused on
// the EBR side, harmless). `filterTerms` restricts to docs whose key+title+description contains them all.
JiTA.rank._cosineScored = function (indexGetter, qv, excludeKey, filterTerms) {
    return indexGetter().then(function (docs) {
        var scored = [];
        for (var d = 0; d < docs.length; d++) {
            if (excludeKey && docs[d].key === excludeKey) { continue; }
            if (JiTA.hidden.isHidden(docs[d].key)) { continue; }   // user-hidden suggestion (temporary, persisted across updates)
            if (filterTerms && filterTerms.length && !JiTA.rank._matchTerms(docs[d].hay, filterTerms)) { continue; }
            if (!JiTA.ui.passesFilter(docs[d])) { continue; }   // session filters (status / recency)
            var sc = JiTA.rank._dot(qv, docs[d].vec);
            if (!isFinite(sc)) { continue; }   // defensively drop any corrupt (NaN/Inf) vector
            scored.push({ key: docs[d].key, project: docs[d].project, summary: docs[d].summary, status: docs[d].status, resolution: docs[d].resolution, resolutiondate: docs[d].resolutiondate, score: sc });
        }
        scored.sort(function (a, c) { return c.score - a.score; });
        return scored;
    });
};

// Cosine-score the DEFECT vectors against the query. [] if none embedded.
JiTA.rank._semanticScored = function (qv, excludeKey, filterTerms) {
    return JiTA.rank._cosineScored(JiTA.rank._ensureVecIndex, qv, excludeKey, filterTerms);
};

/* ---- EBR semantic ranking (stage 2): cosine over OPEN bug-report embeddings ---- */
JiTA.rank._ebrVecIndex = null;
JiTA.rank._dirtyEbrVec = true;
JiTA.rank._buildingEbrVec = null;

// In-memory vector list over OPEN bug reports (project EBR) with a current-version embedding. Mirrors
// _ensureVecIndex but keeps only open EBRs (closed ones aren't ranked and lose their slot).
JiTA.rank._ensureEbrVecIndex = function () {
    return JiTA.rank._ensureCached('_ebrVecIndex', '_dirtyEbrVec', '_buildingEbrVec', function (recs) {
        return JiTA.rank._buildVecIndex(recs, function (r) { return r.project === 'EBR' && !JiTA.util.isClosedStatus(r.status) && !JiTA.util.isGmTeam(r.team); });
    });
};

// Cosine-score the OPEN-EBR vectors against the query. [] if none embedded.
JiTA.rank._semanticScoredEbr = function (qv, excludeKey, filterTerms) {
    return JiTA.rank._cosineScored(JiTA.rank._ensureEbrVecIndex, qv, excludeKey, filterTerms);
};

// Shared HYBRID body for suggestBest / suggestEbrBest: embed the query, cosine-score via semFn, fall back to
// keyword when nothing is embedded (or the filter excluded all), else pull the BM25 candidates via bmFn and
// RRF-fuse (with optional `demote`, defect side only). A query-time embed failure (e.g. a WebGPU device loss)
// drops the possibly-dead pipeline - we do NOT auto-switch backend, that's the user's menu choice - and shows
// keyword results for now.
JiTA.rank._hybridResults = function (text, key, filterTerms, semFn, bmFn, keywordOnly, demote) {
    return JiTA.rank._embedQuery(text).then(function (qv) {
        return semFn(qv, key, filterTerms).then(function (sem) {
            if (!sem.length) { return keywordOnly(); }
            return bmFn(text, key, JiTA.rank.CAND, filterTerms).then(function (bm) {
                return { mode: 'Hybrid', results: JiTA.rank._fuse(sem, bm, demote) };
            });
        });
    }).catch(function () {
        JiTA.embed._resetPipe();
        return keywordOnly();
    });
};

// Shared mode-selection tail: honor a forced Keyword override, go straight to hybrid() when the model is ready,
// keyword() when it's permanently unavailable, else kick off the warm-up and give the model a brief window
// (WARM_WAIT_MS) - resolving to hybrid() if it loads in time (skipping the keyword->hybrid flicker), else
// keyword() now (prepare()'s later re-render upgrades it once the model is ready).
JiTA.rank._pickMode = function (forceMode, keywordOnly, hybrid) {
    if (forceMode === 'Keyword') { return keywordOnly(); }
    if (JiTA.embed.ready) { return hybrid(); }
    if (JiTA.embed.unavailable) { return keywordOnly(); }
    JiTA.embed.prepare();
    return new Promise(function (resolve) {
        var settled = false;
        var timer = setTimeout(function () { if (settled) { return; } settled = true; resolve(keywordOnly()); }, JiTA.embed.WARM_WAIT_MS);
        JiTA.embed.load().then(function () {
            if (settled) { return; }
            settled = true; clearTimeout(timer);
            resolve(hybrid());
        }, function () {
            if (settled) { return; }
            settled = true; clearTimeout(timer);
            resolve(keywordOnly());
        });
    });
};

// Choose the best available ranking. With the model loaded we do HYBRID retrieval: fuse the semantic
// (cosine) and BM25 keyword candidate lists with Reciprocal Rank Fusion. This is the key recall fix - exact
// shared terms (item/module names, error strings) that embeddings smooth over are caught by BM25, while
// paraphrases are caught by the embeddings, so the "obvious" duplicate surfaces far more reliably.
// Returns { mode: 'Hybrid' | 'Keyword', results: [...] } with a display % already attached to each result.
JiTA.rank.suggestBest = function (text, key, brCreated, forceMode, filterTerms) {
    // Feature A: gently demote a Closed defect that was fixed long before this bug report was filed - it
    // is very unlikely to be the report's real duplicate. Scales whatever score fields the result carries
    // (score / rrf / pct) by the age factor and tags it so the panel can grey it and explain why.
    function demote(r) {
        if (!brCreated || !r.resolutiondate || !JiTA.util.isResolved(r.status, r.resolution)) { return; }
        var sf = JiTA.util.staleFactor(brCreated, r.resolutiondate);
        if (sf.factor >= 1) { return; }
        if (typeof r.score === 'number') { r.score *= sf.factor; }
        if (typeof r.rrf === 'number') { r.rrf *= sf.factor; }
        if (typeof r.pct === 'number') { r.pct = Math.round(r.pct * sf.factor); }
        r.stale = true;
        // Note: the meta line already shows the status ("Closed"), so don't repeat it here - just the gap.
        r.staleNote = 'fixed ' + JiTA.util.humanizeAge(sf.ageDays) + ' before report';
    }
    function keywordOnly() {
        // Pull a wider candidate set so the demotion can re-order before we cut to TOP_N (a stale match
        // shouldn't keep a slot a fresher one deserves).
        return JiTA.rank.suggest(text, key, JiTA.rank.CAND, filterTerms).then(function (list) {
            for (var d = 0; d < list.length; d++) { demote(list[d]); }
            list.sort(function (a, c) { return c.score - a.score; });
            list = list.slice(0, JiTA.TOP_N);
            var top = (list[0] && list[0].score) || 0;
            for (var i = 0; i < list.length; i++) { list[i].pct = top > 0 ? Math.round(list[i].score / top * 100) : 0; }
            return { mode: 'Keyword', results: list };
        });
    }
    // HYBRID (semantic + keyword, RRF-fused) over the DEFECT indexes, with stale-match demotion.
    function hybrid() {
        return JiTA.rank._hybridResults(text, key, filterTerms, JiTA.rank._semanticScored, JiTA.rank.suggest, keywordOnly, demote);
    }
    return JiTA.rank._pickMode(forceMode, keywordOnly, hybrid);
};

// EDR (defect) -> matching OPEN bug reports, best available ranking. Same hybrid (semantic + BM25, fused
// with RRF) approach as suggestBest, but over the EBR indexes and with no stale-demotion (open reports have
// no fix date). Returns { mode: 'Hybrid' | 'Keyword', results: [...] } with a display % per result.
JiTA.rank.suggestEbrBest = function (text, key, forceMode, filterTerms) {
    function keywordOnly() {
        // suggestEbr already attaches a top-relative pct.
        return JiTA.rank.suggestEbr(text, key, JiTA.TOP_N, filterTerms).then(function (list) {
            return { mode: 'Keyword', results: list };
        });
    }
    // HYBRID over the OPEN-EBR indexes; no stale-demotion (open reports have no fix date).
    function hybrid() {
        return JiTA.rank._hybridResults(text, key, filterTerms, JiTA.rank._semanticScoredEbr, JiTA.rank.suggestEbr, keywordOnly);
    }
    return JiTA.rank._pickMode(forceMode, keywordOnly, hybrid);
};


/* ---- issue linking: "mark as duplicate" (Feature B) ---- */
JiTA.link = {
    _info: null,   // cached { name, ebrSide } - the link-type name + which side the EBR goes on
    _me: null,     // cached current-user accountId (for the defect-side attach assignee gate)

    // Resolve the current user's accountId (cached). Used by the defect-side "Attach" control to gate which
    // bug reports may be attached (only unassigned ones, or ones already assigned to me). Prefer the
    // ajs-atlassian-account-id meta tag Jira renders into the page; fall back to /myself. Resolves null if
    // it can't be determined (callers then disallow attaching anything that IS assigned, to be safe).
    currentUser: function () {
        if (JiTA.link._me) { return Promise.resolve(JiTA.link._me); }
        var meta = document.querySelector('meta[name="ajs-atlassian-account-id"]');
        var id = meta && meta.getAttribute('content');
        if (id) { JiTA.link._me = id; return Promise.resolve(id); }
        return new Promise(function (resolve) {
            $.ajax({ url: JiTA.HOST + '/rest/api/2/myself', dataType: 'json' })
                .done(function (d) { JiTA.link._me = (d && d.accountId) || null; resolve(JiTA.link._me); })
                .fail(function () { resolve(null); });
        });
    },

    // Resolve the duplicate link type AND the side the bug report must sit on so the EBR reads "duplicates"
    // (not "is duplicated by"). Jira links go outward->inward: the outward issue shows the type's `outward`
    // text. So we find the type where "duplicates" is the outward text (EBR = outward) OR the inward text
    // (then EBR = inward, so it still reads "duplicates"). The EVE instance uses custom link types and we
    // can't assume the standard direction, so this is discovered at runtime, cached in memory + GM. (Cache
    // key is versioned because an earlier build cached only the name and could link the wrong way round.)
    dupInfo: function () {
        if (JiTA.link._info) { return Promise.resolve(JiTA.link._info); }
        var cached = gmGet('sdDupLink_v2', null);
        if (cached && cached.name) { JiTA.link._info = cached; return Promise.resolve(cached); }
        return new Promise(function (resolve) {
            $.ajax({ url: JiTA.HOST + '/rest/api/3/issueLinkType', dataType: 'json' })
                .done(function (d) {
                    var types = (d && d.issueLinkTypes) || [];
                    var info = null;
                    for (var i = 0; i < types.length && !info; i++) {
                        var t = types[i];
                        if (/^duplicates$/i.test(t.outward || '')) { info = { name: t.name, ebrSide: 'outward' }; }
                        else if (/^duplicates$/i.test(t.inward || '')) { info = { name: t.name, ebrSide: 'inward' }; }
                    }
                    if (!info) { info = { name: 'Duplicate', ebrSide: 'outward' }; }   // sensible default
                    JiTA.link._info = info;
                    gmSet('sdDupLink_v2', info);
                    resolve(info);
                })
                .fail(function () { resolve({ name: 'Duplicate', ebrSide: 'outward' }); });
        });
    },

    // Link `ebrKey` as a duplicate of `otherKey`: the bug report should read "duplicates <defect>". We put
    // the EBR on whichever side carries the "duplicates" phrasing (see dupInfo). We use a dedicated $.ajax
    // (not sync._apiPost) because a successful POST /issueLink returns 201 with an EMPTY body, which a json
    // dataType would mis-treat as a parse error. Resolves on any 2xx; rejects with the HTTP status
    // (403 ~ missing link permission).
    markDuplicate: function (ebrKey, otherKey) {
        return JiTA.link.dupInfo().then(function (info) {
            var body = { type: { name: info.name } };
            // NOTE: on this instance the issue placed as `outwardIssue` ends up DISPLAYING the type's INWARD
            // text (and vice-versa) - the opposite of the documented direction. So to make the EBR read
            // "duplicates", we put the EBR on the side OPPOSITE its dupInfo `ebrSide`.
            if (info.ebrSide === 'inward') {
                body.outwardIssue = { key: ebrKey }; body.inwardIssue = { key: otherKey };
            } else {
                body.inwardIssue = { key: ebrKey }; body.outwardIssue = { key: otherKey };
            }
            return new Promise(function (resolve, reject) {
                $.ajax({
                    url: JiTA.HOST + '/rest/api/3/issueLink',
                    type: 'POST',
                    contentType: 'application/json',
                    headers: { 'X-Atlassian-Token': 'no-check' },
                    data: JSON.stringify(body)
                }).done(function () { resolve(); })
                  .fail(function (xhr) {
                      // A successful POST /issueLink is 201 with an EMPTY body; jQuery then fires `fail` with
                      // a "parsererror" even though the link was created. Treat any 2xx as success.
                      if (xhr.status >= 200 && xhr.status < 300) { resolve(); return; }
                      reject(new Error('HTTP ' + xhr.status + (xhr.status === 403 ? ' (no link permission?)' : '')));
                  });
            });
        });
    },

    // Build the issuelinks "add" operation for a transition `update`, so the EBR (the implicit current
    // issue being transitioned) reads "duplicates" the defect. On this instance the displayed text is the
    // OPPOSITE side from where the OTHER issue is placed, so we put the defect on the SAME side that carries
    // the "duplicates" phrasing (dupInfo `ebrSide`).
    _dupAddOp: function (info, otherKey) {
        var add = { type: { name: info.name } };
        if (info.ebrSide === 'outward') { add.outwardIssue = { key: otherKey }; }
        else { add.inwardIssue = { key: otherKey }; }
        return { add: add };
    },

    // One-shot "mark as duplicate": move the EBR to `statusName` (e.g. "Attached"), set the Resolution, AND
    // add the duplicate link to the defect - all in the SINGLE transition POST, because the Attached
    // transition screen exposes both Resolution and Linked Issues fields. This avoids the separate
    // /issueLink call (and its 201-empty-body quirk) and keeps everything in one place.
    // Graceful fallbacks: if the transition screen has no Linked Issues field we transition, then create the
    // link separately; if there's no such transition at all we just create the link. Resolves with
    // { attached: bool, linked: bool }.
    attachDuplicate: function (ebrKey, otherKey, statusName, preferredResolution, assigneeAccountId) {
        return JiTA.link.dupInfo().then(function (info) {
            return new Promise(function (resolve, reject) {
                $.ajax({ url: JiTA.HOST + '/rest/api/3/issue/' + ebrKey + '/transitions?expand=transitions.fields', dataType: 'json' })
                    .done(function (d) {
                        var trans = (d && d.transitions) || [];
                        var want = (statusName || '').toLowerCase(), t = null;
                        for (var i = 0; i < trans.length; i++) {
                            var toName = (trans[i].to && trans[i].to.name || '').toLowerCase();
                            var trName = (trans[i].name || '').toLowerCase();
                            if (toName === want || trName === want) { t = trans[i]; break; }
                        }
                        // No such transition from the current state -> just create the link on its own.
                        if (!t) {
                            JiTA.link.markDuplicate(ebrKey, otherKey)
                                .then(function () { resolve({ attached: false, linked: true }); }, reject);
                            return;
                        }
                        var payload = { transition: { id: t.id } };
                        // Resolution field on the screen: prefer the requested one (e.g. "Duplicate"), else
                        // the first allowed value when it's required.
                        var rf = t.fields && t.fields.resolution;
                        if (rf) {
                            var allowed = rf.allowedValues || [], chosen = null, pref = (preferredResolution || '').toLowerCase();
                            for (var a = 0; a < allowed.length; a++) {
                                if (pref && (allowed[a].name || '').toLowerCase() === pref) { chosen = allowed[a]; break; }
                            }
                            if (!chosen && rf.required && allowed.length) { chosen = allowed[0]; }
                            if (chosen) { payload.fields = { resolution: { id: chosen.id } }; }
                        }
                        // Assignee field on the screen: when an account id is passed (the defect-side attach),
                        // set it so the attached report is attributed to the triager - mirrors Jira's native
                        // Attach dialog, which posts the assignee, and covers a transition screen that requires
                        // one. Only set it when the screen actually carries the field.
                        if (assigneeAccountId && t.fields && t.fields.assignee) {
                            payload.fields = payload.fields || {};
                            payload.fields.assignee = { accountId: assigneeAccountId };
                        }
                        // Linked Issues field on the screen: add the duplicate link inline (single call).
                        var hasLinkField = !!(t.fields && t.fields.issuelinks);
                        if (hasLinkField) { payload.update = { issuelinks: [ JiTA.link._dupAddOp(info, otherKey) ] }; }

                        function done2xx() {
                            if (hasLinkField) { resolve({ attached: true, linked: true }); return; }
                            // Screen didn't carry the link field -> transition done, now link separately.
                            JiTA.link.markDuplicate(ebrKey, otherKey)
                                .then(function () { resolve({ attached: true, linked: true }); },
                                      function () { resolve({ attached: true, linked: false }); });
                        }
                        $.ajax({
                            url: JiTA.HOST + '/rest/api/3/issue/' + ebrKey + '/transitions',
                            type: 'POST',
                            contentType: 'application/json',
                            headers: { 'X-Atlassian-Token': 'no-check' },
                            data: JSON.stringify(payload)
                        }).done(done2xx)
                          .fail(function (xhr) {
                              // A successful transition is 204 (empty body) -> jQuery "parsererror"; treat 2xx as success.
                              if (xhr.status >= 200 && xhr.status < 300) { done2xx(); return; }
                              reject(new Error('transition HTTP ' + xhr.status));
                          });
                    })
                    .fail(function (xhr) { reject(new Error('transitions HTTP ' + xhr.status)); });
            });
        });
    }
};


/* ---- UI: floating suggestions panel ---- */
JiTA.ui = {
    currentKey: null,
    _toastTimer: null,

    css: '\
#jita-sd-panel { position: fixed; right: 18px; bottom: 18px; width: 340px; max-height: 52vh; z-index: 9000;\
  background: #1D2125; color: #e6e6e6; border: 1px solid #3a434d; border-radius: 6px; box-shadow: 0 4px 18px rgba(0,0,0,.45);\
  font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; font-size: 12px; display: flex; flex-direction: column; overflow: hidden; }\
#jita-sd-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: #282d33; cursor: move; user-select: none; }\
#jita-sd-panel.jita-sd-dragging { opacity: .92; }\
#jita-sd-title { font-weight: 700; flex: 1; }\
#jita-sd-mode { font-size: 10px; background: #3a434d; padding: 1px 6px; border-radius: 8px; cursor: pointer; user-select: none; }\
#jita-sd-mode:hover { background: #4a545f; }\
#jita-sd-filter { flex: 1 1 60px; min-width: 0; height: 20px; box-sizing: border-box; padding: 0 6px; font-size: 11px; border: 1px solid #3a434d; border-radius: 8px; background: #14181b; color: #e6e6e6; outline: none; }\
#jita-sd-filter:focus { border-color: #4c9aff; }\
#jita-sd-collapse { cursor: pointer; padding: 0 4px; font-weight: 700; }\
#jita-sd-status { padding: 6px 10px; color: #aab3bd; border-bottom: 1px solid #2c333a; }\
#jita-sd-list { list-style: none; margin: 0; padding: 0; overflow-y: auto; }\
#jita-sd-list li { padding: 7px 10px; border-bottom: 1px solid #2c333a; min-width: 0; overflow-wrap: anywhere; word-break: break-word; }\
#jita-sd-list a { color: #4c9aff; font-weight: 700; text-decoration: none; overflow-wrap: anywhere; }\
#jita-sd-list a:hover { text-decoration: underline; }\
.jita-sd-proj { font-size: 10px; background: #3a434d; padding: 0 5px; border-radius: 7px; margin-left: 6px; }\
.jita-sd-score { float: right; color: #7a8694; font-size: 10px; }\
.jita-sd-link { float: right; margin-right: 8px; font-size: 10px; color: #9fb4cc; cursor: pointer; user-select: none; }\
.jita-sd-link:hover { color: #4c9aff; text-decoration: underline; }\
.jita-sd-link.jita-sd-linking { color: #7a8694; cursor: default; text-decoration: none; }\
.jita-sd-link.jita-sd-linked { color: #4caf7d; cursor: default; text-decoration: none; }\
.jita-sd-link.jita-sd-noattach { color: #7a8694 !important; cursor: default; text-decoration: none; }\
.jita-sd-hide { float: right; margin-right: 8px; cursor: pointer; color: #7a8694; display: inline-flex; align-items: center; user-select: none; }\
.jita-sd-hide:hover { color: #ff8f8f; }\
.jita-sd-hide svg { display: block; }\
#jita-sd-hidemenu { position: fixed; z-index: 10002; background: #14181b; color: #e6e6e6; border: 1px solid #3a434d; border-radius: 6px; box-shadow: 0 6px 24px rgba(0,0,0,.55); padding: 6px; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; font-size: 12px; min-width: 150px; }\
#jita-sd-hidemenu .jita-sd-hidemenu-label { color: #9aa6b2; font-size: 10px; padding: 2px 6px 6px; white-space: nowrap; }\
#jita-sd-hidemenu .jita-sd-hidemenu-btn { display: block; width: 100%; text-align: left; background: transparent; color: #e6e6e6; border: none; border-radius: 4px; padding: 6px 8px; cursor: pointer; font-size: 12px; }\
#jita-sd-hidemenu .jita-sd-hidemenu-btn:hover { background: #2c333a; }\
#jita-sd-filterbtn { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 6px; color: #9aa6b2; cursor: pointer; user-select: none; position: relative; flex: 0 0 auto; }\
#jita-sd-filterbtn:hover { color: #e6e6e6; background: #3a434d; }\
#jita-sd-filterbtn.active { color: #4c9aff; }\
#jita-sd-filterbtn.active::after { content: ""; position: absolute; top: 1px; right: 1px; width: 5px; height: 5px; border-radius: 50%; background: #4c9aff; }\
#jita-sd-filtermenu { position: fixed; z-index: 10002; background: #14181b; color: #e6e6e6; border: 1px solid #3a434d; border-radius: 6px; box-shadow: 0 6px 24px rgba(0,0,0,.55); padding: 10px; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; font-size: 12px; min-width: 190px; }\
#jita-sd-filtermenu .jita-fm-label { color: #9aa6b2; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; margin: 2px 0 5px; }\
#jita-sd-filtermenu .jita-fm-seg { display: flex; margin-bottom: 10px; border: 1px solid #3a434d; border-radius: 6px; overflow: hidden; }\
#jita-sd-filtermenu .jita-fm-segbtn { flex: 1; background: transparent; color: #cfd6dd; border: none; border-right: 1px solid #3a434d; padding: 5px 6px; cursor: pointer; font-size: 12px; }\
#jita-sd-filtermenu .jita-fm-segbtn:last-child { border-right: none; }\
#jita-sd-filtermenu .jita-fm-segbtn:hover { background: #2c333a; }\
#jita-sd-filtermenu .jita-fm-segbtn.on { background: #4c9aff; color: #fff; font-weight: 700; }\
#jita-sd-filtermenu .jita-fm-created { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }\
#jita-sd-filtermenu .jita-fm-num { width: 54px; background: #0f1316; color: #e6e6e6; border: 1px solid #3a434d; border-radius: 4px; padding: 4px 6px; font-size: 12px; outline: none; }\
#jita-sd-filtermenu .jita-fm-num:focus { border-color: #4c9aff; }\
#jita-sd-filtermenu .jita-fm-unit { color: #9aa6b2; margin-right: 2px; }\
#jita-sd-filtermenu .jita-fm-chip { background: #2c333a; color: #cfd6dd; border: 1px solid #3a434d; border-radius: 10px; padding: 2px 8px; cursor: pointer; font-size: 11px; }\
#jita-sd-filtermenu .jita-fm-chip:hover { border-color: #4c9aff; color: #fff; }\
#jita-sd-filtermenu .jita-fm-reset { display: block; width: 100%; margin-top: 10px; background: transparent; color: #9aa6b2; border: 1px solid #3a434d; border-radius: 5px; padding: 5px; cursor: pointer; font-size: 11px; }\
#jita-sd-filtermenu .jita-fm-reset:hover { color: #fff; border-color: #4c9aff; }\
#jita-sd-filtermenu .jita-fm-view { display: block; width: 100%; margin: 0 0 10px; background: #2c333a; color: #cfd6dd; border: 1px solid #3a434d; border-radius: 5px; padding: 6px; cursor: pointer; font-size: 12px; text-align: center; }\
#jita-sd-filtermenu .jita-fm-view:hover { color: #fff; border-color: #4c9aff; }\
#jita-sd-filtermenu .jita-fm-view.on { background: #4c9aff; color: #fff; font-weight: 700; border-color: #4c9aff; }\
.jita-sd-list li.jita-sd-stale { opacity: .6; }\
.jita-sd-sum { margin-top: 2px; color: #e6e6e6; overflow-wrap: anywhere; word-break: break-word; }\
.jita-sd-meta { margin-top: 2px; color: #7a8694; font-size: 10px; overflow-wrap: anywhere; word-break: break-word; }\
.jita-sd-date { margin-top: 2px; color: #7a8694; font-size: 10px; text-align: right; }\
#jita-sd-loglink { display: none; padding: 6px 10px; border-bottom: 1px solid #2c333a; background: #20262b; }\
#jita-sd-loglink.has-hits { display: block; }\
#jita-sd-loglink .jita-sd-loglink-head { font-weight: 700; color: #ffb547; font-size: 11px; margin-bottom: 4px; }\
#jita-sd-loglink ul { list-style: none; margin: 0; padding: 0; }\
#jita-sd-loglink li { padding: 3px 0; cursor: default; }\
#jita-sd-loglink a { color: #4c9aff; font-weight: 700; text-decoration: none; }\
#jita-sd-loglink a:hover { text-decoration: underline; }\
#jita-sd-loglink .count { color: #cfd6dd; background: #3a434d; border-radius: 8px; padding: 0 7px; font-size: 10px; font-weight: 700; margin-left: 6px; }\
.jita-sd-loose { font-size: 10px; color: #9aa6b2; margin-left: 6px; }\
#jita-sd-exccluster { display: none; padding: 6px 10px; border-bottom: 1px solid #2c333a; background: #20262b; }\
#jita-sd-exccluster.has-hits { display: block; }\
#jita-sd-exccluster .jita-sd-exccluster-head { font-weight: 700; color: #cfd6dd; font-size: 11px; margin-bottom: 4px; }\
#jita-sd-panel.collapsed #jita-sd-status, #jita-sd-panel.collapsed #jita-sd-loglink, #jita-sd-panel.collapsed #jita-sd-exccluster, #jita-sd-panel.collapsed #jita-sd-list { display: none; }\
#jita-sd-panel.jita-sd-up { flex-direction: column-reverse; }\
#jita-sd-toast { position: fixed; right: 18px; bottom: 18px; z-index: 9001; background: #333; color: #eee; padding: 8px 14px;\
  border-radius: 6px; box-shadow: 0 4px 18px rgba(0,0,0,.45); font-family: -apple-system,Arial,sans-serif; font-size: 12px; max-width: 320px; }\
#jita-sd-tip { position: fixed; z-index: 10001; display: none; width: 420px; max-height: 60vh; overflow-y: auto;\
  background: #14181b; color: #e6e6e6; border: 1px solid #3a434d; border-radius: 6px; box-shadow: 0 6px 24px rgba(0,0,0,.55);\
  padding: 10px 12px; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; font-size: 12px; line-height: 1.45; pointer-events: none; }\
#jita-sd-tip .jita-sd-tip-title { font-weight: 700; color: #fff; margin-bottom: 4px; }\
#jita-sd-tip .jita-sd-tip-meta { color: #9fb4cc; font-size: 10px; margin-bottom: 6px; }\
#jita-sd-tip .jita-sd-tip-desc { color: #cfd6dd; white-space: pre-wrap; word-break: break-word; }\
#jita-sd-tip .jita-sd-tip-dim { color: #7a8694; font-style: italic; }\
#jita-sd-tip .jita-sd-tip-media { color: #9fb4cc; font-style: italic; padding: 6px 0; }\
#jita-sd-tip .jita-sd-tip-html { white-space: normal; }\
#jita-sd-tip .jita-sd-tip-html p { margin: 0 0 8px; }\
#jita-sd-tip .jita-sd-tip-html p:last-child { margin-bottom: 0; }\
#jita-sd-tip .jita-sd-tip-html ul, #jita-sd-tip .jita-sd-tip-html ol { margin: 4px 0; padding-left: 18px; }\
#jita-sd-tip .jita-sd-tip-html h1, #jita-sd-tip .jita-sd-tip-html h2, #jita-sd-tip .jita-sd-tip-html h3, #jita-sd-tip .jita-sd-tip-html h4 { font-size: 12px; font-weight: 700; color: #fff; margin: 8px 0 4px; }\
#jita-sd-tip .jita-sd-tip-html pre { white-space: pre-wrap; word-break: break-word; background: #0f1316; border: 1px solid #2c333a; border-radius: 4px; padding: 6px 8px; margin: 6px 0; font-family: "Courier New",monospace; font-size: 11px; }\
#jita-sd-tip .jita-sd-tip-html code { font-family: "Courier New",monospace; }\
#jita-sd-tip .jita-sd-tip-html img { max-width: 100%; height: auto; }\
#jita-sd-tip .jita-sd-tip-html a { color: #4c9aff; }\
#jita-sd-tip .jita-sd-tip-html table { border-collapse: collapse; margin: 6px 0; }\
#jita-sd-tip .jita-sd-tip-html th, #jita-sd-tip .jita-sd-tip-html td { border: 1px solid #2c333a; padding: 2px 6px; }\
/* ---- integrated "Triage Assistant" context group (sidebar mode) ---- */\
/* Styled with Atlassian design tokens so it blends into the native panel in both light + dark themes. */\
/* Native-clone path (default): the cloned Details group already supplies the card / header / title font, so\
   we only need to hide its body and rotate its chevron on collapse. */\
#jita-side-group.collapsed [data-jita-body] { display: none !important; }\
/* We clone a real context group (Development / More fields) for exact chrome, then swap the chevron path in\
   JS - down caret when open, right caret when collapsed - matching how Jira itself toggles it (no CSS rotate).\
   The cloned group ships without a full card border, so we draw our own complete bordered card and drop the\
   inner wrapper partial border so we do not double up. */\
#jita-side-group.jita-ta-native { margin: 8px 0; border: 1px solid var(--ds-border, #091e4224); border-radius: 8px; box-sizing: border-box; overflow: hidden; }\
#jita-side-group.jita-ta-native > div { border: none; }\
/* Kill the lingering focus ring on the (cloned) header button after a collapse-toggle click - the cloned\
   role=button keeps focus and Jira draws a blue outline/box-shadow around the whole card, which we do not\
   want on this static toggle. */\
#jita-side-group:focus, #jita-side-group:focus-within, #jita-side-group:focus-visible,\
#jita-side-group *:focus, #jita-side-group *:focus-visible,\
#jita-side-header:focus, #jita-side-header:focus-visible { outline: none !important; box-shadow: none !important; }\
/* Manual fallback path: drawn by hand to mimic the native group when the clone template is unavailable. */\
#jita-side-group.jita-ta-manual { margin: 8px 0; padding: 0 16px 4px; border: 1px solid var(--ds-border, #091e4224); border-radius: 8px; }\
#jita-side-group.jita-ta-manual.collapsed { padding-bottom: 0; }\
#jita-side-header { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; padding: 14px 0; }\
#jita-side-header .jita-side-chevron { display: inline-flex; color: var(--ds-icon-subtle, #626f86); }\
#jita-side-header .jita-side-chevron svg { width: 16px; height: 16px; }\
#jita-side-header .jita-side-htitle { flex: 1; font-weight: 600; font-size: 16px; line-height: 1; color: var(--ds-text, #172b4d); }\
#jita-side-group .jita-side-body { padding-bottom: 8px; padding-right: 14px; }\
.jita-side-subhead { display: flex; align-items: center; gap: 8px; margin: 2px 0 4px; }\
.jita-side-subhead #jita-sd-title { flex: 1; font-weight: 600; font-size: 12px; color: var(--ds-text-subtle, #44546f); }\
#jita-side-group #jita-sd-mode { font-size: 10px; background: var(--ds-background-neutral, #091e420f); color: var(--ds-text-subtle, #44546f); padding: 1px 6px; border-radius: 8px; }\
#jita-side-group #jita-sd-filterbtn { color: var(--ds-text-subtle, #44546f); }\
#jita-side-group #jita-sd-filterbtn:hover { color: var(--ds-text, #172b4d); background: var(--ds-background-neutral, #091e420f); }\
#jita-side-group #jita-sd-filterbtn.active { color: var(--ds-link, #0c66e4); }\
#jita-side-group #jita-sd-filterbtn.active::after { background: var(--ds-link, #0c66e4); }\
#jita-side-group #jita-sd-filter { background: var(--ds-surface, #fff); color: var(--ds-text, #172b4d); border-color: var(--ds-border-input, #8590a2); }\
#jita-side-group #jita-sd-filter:focus { border-color: var(--ds-border-focused, #388bff); }\
#jita-side-group #jita-sd-status { padding: 4px 0; border-bottom: none; color: var(--ds-text-subtlest, #626f86); }\
#jita-side-group #jita-sd-loglink { display: none; padding: 6px 0; border-bottom: 1px solid var(--ds-border, #091e4224); background: transparent; }\
#jita-side-group #jita-sd-loglink.has-hits { display: block; }\
#jita-side-group #jita-sd-loglink .jita-sd-loglink-head { color: var(--ds-text-warning, #974f0c); }\
#jita-side-group #jita-sd-exccluster { display: none; padding: 6px 0; border-bottom: 1px solid var(--ds-border, #091e4224); background: transparent; }\
#jita-side-group #jita-sd-exccluster.has-hits { display: block; }\
#jita-side-group #jita-sd-exccluster .jita-sd-exccluster-head { color: var(--ds-text, #172b4d); }\
#jita-side-group #jita-sd-exccluster .jita-exc-member a { color: var(--ds-link, #0c66e4); }\
/* Responsive 2-up grid: two columns once the context column is wide enough (each cell >= 180px),\
   automatically collapsing to one column when narrow. The min track is 180px (not 280px) because the Jira\
   context column on a 1920-wide screen is only ~400px, so a 280px min never left room for a second column\
   there; 180px fits two columns (2*180 + 14px gap) in that width while still collapsing to one on a narrow\
   laptop. align-items:stretch so both cards in a row share the height of the taller one (columns line up). */\
#jita-side-group #jita-sd-list { overflow: visible; display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); column-gap: 14px; align-items: stretch; }\
/* Each card is position:relative + bottom padding so the created date can be pinned to the bottom-right\
   (absolute) of the STRETCHED cell - so the dates line up across the two columns even when one card has\
   less content than the other (the short card no longer floats its date mid-card with a gap below it). */\
#jita-side-group #jita-sd-list li { position: relative; padding: 7px 0 22px; border-bottom: 1px solid var(--ds-border, #091e4224); }\
#jita-side-group .jita-sd-date { position: absolute; right: 0; bottom: 7px; margin-top: 0; }\
/* With a grid the simple :last-child no-border rule is wrong (only kills one of the bottom row); leave\
   borders on every item - a faint divider under each card reads fine in either column count. */\
#jita-side-group #jita-sd-list a, #jita-side-group .jita-sd-link { color: var(--ds-link, #0c66e4); }\
#jita-side-group .jita-sd-sum { color: var(--ds-text, #172b4d); }\
#jita-side-group .jita-sd-meta, #jita-side-group .jita-sd-score, #jita-side-group .jita-sd-date { color: var(--ds-text-subtlest, #626f86); }\
#jita-side-group .jita-sd-proj { background: var(--ds-background-neutral, #091e420f); color: var(--ds-text-subtle, #44546f); }\
#jita-side-group .jita-sd-hide { color: var(--ds-text-subtlest, #626f86); }\
#jita-side-group .jita-sd-hide:hover { color: #c9372c; }\
#jita-side-group .jita-sd-link.jita-sd-linked { color: var(--ds-text-success, #216e4e); }',

    injectCss: function () {
        if (!JiTA.ui._cssInjected) { GM_addStyle(JiTA.ui.css); JiTA.ui._cssInjected = true; }
    },

    // Brief transient message (e.g. sync started/finished), independent of the panel.
    toast: function (msg) {
        JiTA.ui.injectCss();
        var $t = $('#jita-sd-toast');
        if (!$t.length) { $t = $('<div id="jita-sd-toast"></div>').appendTo(document.body); }
        $t.text(msg).show();
        if (JiTA.ui._toastTimer) { clearTimeout(JiTA.ui._toastTimer); }
        JiTA.ui._toastTimer = setTimeout(function () { $('#jita-sd-toast').fadeOut(400); }, 4000);
    },

    setStatus: function (msg) { $('#jita-sd-status').text(msg); },

    // ---- live filter box + clickable ranking-mode badge (left of the Keyword/Hybrid label) ----
    // The filter re-QUERIES the whole local database (not just the rows already on screen): the typed word(s)
    // are pushed into the ranker as a hard pre-filter, so it picks the best TOP_N matches from EVERY stored
    // defect / bug report whose key+title+description contains ALL the terms (AND semantics). Empty -> normal
    // ranking. Debounced so a burst of keystrokes triggers a single re-render.
    // The Keyword/Hybrid badge is clickable: it toggles a SESSION-ONLY ranking-mode override (Hybrid <-> Keyword)
    // and re-renders. The override is in-memory only, so a reload resets it to automatic (which prefers Hybrid
    // whenever the embedding model is available).
    modeOverride: null,        // null = automatic (prefer Hybrid); 'Hybrid' / 'Keyword' = user-forced this session
    reporterMode: false,       // EBR view: when on, the panel lists the reporter's OTHER reports instead of similar defects (session-only; reset on navigation)
    _filterTimer: null,
    _wireFilter: function () {
        if (JiTA.ui._filterWired) { return; }   // one set of delegated handlers survives chrome re-mounts
        JiTA.ui._filterWired = true;
        $(document).on('click', '#jita-sd-mode', function () { JiTA.ui._cycleMode(); });
        // Funnel button: toggle the filter popover (delegated so it survives the chrome re-mounting).
        $(document).on('click', '#jita-sd-filterbtn', function (e) {
            e.preventDefault(); e.stopPropagation();
            if (document.getElementById('jita-sd-filtermenu')) { JiTA.ui._closeFilterMenu(); }
            else { JiTA.ui._showFilterMenu(this); }
        });
        // Debounced re-query as the user types. (We previously tried to keep Jira from flagging the page as
        // having "unsubmitted changes" - it warns on reload because the filter input lives inside its issue
        // view - but the detection runs ahead of anything we can intercept, so we just accept the warning.)
        $(document).on('input', '#jita-sd-filter', function () {
            if (JiTA.ui._filterTimer) { clearTimeout(JiTA.ui._filterTimer); }
            JiTA.ui._filterTimer = setTimeout(function () { JiTA.ui._rerenderCurrent(); }, 200);
        });
    },
    // The active filter terms (lowercased, whitespace-split) from the box, or [] when empty.
    _filterTerms: function () {
        var $inp = $('#jita-sd-filter');
        if (!$inp.length) { return []; }
        var q = ($inp.val() || '').toLowerCase().replace(/\s+/g, ' ').trim();
        return q ? q.split(' ') : [];
    },
    // Re-render whichever view is open (EBR -> similar defects, EDR/EO -> matching reports), re-reading the
    // filter terms + mode override. Used by the filter box and the mode-badge toggle.
    _rerenderCurrent: function () {
        var k = JiTA.ui.currentKey;
        if (!k) { return; }
        if (/^EBR-/.test(k)) { JiTA.ui.render(k); }
        else if (JiTA.ui._isReportsKey(k)) { JiTA.ui.renderReports(k); }
    },
    // Toggle the session ranking-mode override (Hybrid <-> Keyword) and re-render. No-op (with a hint) when
    // semantic embeddings are unavailable, since Hybrid isn't possible then.
    _cycleMode: function () {
        if (JiTA.embed && JiTA.embed.unavailable) { JiTA.ui.toast('Semantic embeddings unavailable - keyword ranking only.'); return; }
        var cur = JiTA.ui.modeOverride;
        if (cur === 'Keyword') { JiTA.ui.modeOverride = 'Hybrid'; }
        else if (cur === 'Hybrid') { JiTA.ui.modeOverride = 'Keyword'; }
        else {   // automatic so far -> flip to the opposite of what's currently displayed
            var shown = ($('#jita-sd-mode').text() || '').toLowerCase();
            JiTA.ui.modeOverride = (shown.indexOf('hybrid') >= 0) ? 'Keyword' : 'Hybrid';
        }
        JiTA.ui._rerenderCurrent();
    },

    // ---- session filters (funnel popover): Status (Open/Fixed/All) + Created-within-N-days ----
    // Deliberately IN-MEMORY only, like modeOverride: a reload resets them. `passesFilter` is called as a
    // per-candidate predicate inside every ranking loop (BM25 + semantic, defect + report), so filtered docs
    // are dropped BEFORE the TOP_N cut - you always get a full N of matching results, not N-minus-the-filtered.
    filters: { status: 'all', createdDays: 0 },   // status: 'all'|'open'|'fixed'; createdDays: 0 = off

    // True iff a candidate passes the current session filters. Status applies to DEFECT candidates only (open
    // bug reports are open by definition, so it's a no-op on the reports view even if 'fixed' is left set).
    // Created-within applies to any candidate carrying a `created` date.
    passesFilter: function (doc) {
        var f = JiTA.ui.filters;
        if (!f) { return true; }
        if (f.status && f.status !== 'all' && doc.project !== 'EBR') {
            var resolved = JiTA.util.isResolved(doc.status, doc.resolution);
            if (f.status === 'open' && resolved) { return false; }
            if (f.status === 'fixed' && !resolved) { return false; }
        }
        if (f.createdDays > 0) {
            var t = doc.created ? Date.parse(doc.created) : NaN;
            if (isNaN(t) || (Date.now() - t) > f.createdDays * 86400000) { return false; }   // unknown/too-old age
        }
        return true;
    },

    // Whether any filter that AFFECTS the current view is active (drives the funnel's active dot). Status only
    // counts on the similar-defects (EBR) view; Created counts on both.
    _filtersActive: function () {
        var f = JiTA.ui.filters;
        if (!f) { return false; }
        var onEbr = /^EBR-/.test(JiTA.ui.currentKey || '');
        if (onEbr && JiTA.ui.reporterMode) { return true; }   // reporter's-other-reports view is active
        return !!((onEbr && f.status && f.status !== 'all') || f.createdDays > 0);
    },

    _funnelSvg: '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M1 2.6c0-.33.27-.6.6-.6h12.8c.33 0 .6.27.6.6 0 .14-.05.28-.14.39L10 8.7v4.3a.6.6 0 0 1-.87.54l-2.4-1.2A.6.6 0 0 1 6 11.8V8.7L1.14 2.99A.6.6 0 0 1 1 2.6z"/></svg>',

    // Reflect the active-filter state on the funnel button (colored + dot). Called on every render + change.
    _syncFilterBtn: function () {
        var $b = $('#jita-sd-filterbtn');
        if ($b.length) { $b.toggleClass('active', JiTA.ui._filtersActive()); }
    },

    // Build + show the filter popover under the funnel button. Rebuilt each open so it can be view-aware
    // (Status is only shown on the similar-defects view). Changes update JiTA.ui.filters + re-render live.
    _showFilterMenu: function (anchor) {
        JiTA.ui._closeFilterMenu();
        JiTA.ui._hideTip();
        var f = JiTA.ui.filters;
        var onEbr = /^EBR-/.test(JiTA.ui.currentKey || '');   // similar-defects view -> Status applies
        var menu = document.createElement('div');
        menu.id = 'jita-sd-filtermenu';

        // Reporter's-other-reports toggle (EBR view only): swaps the similar-defects list for this reporter's
        // other synced reports, and back. In reporter mode the ranking filters below don't apply, so they're hidden.
        if (onEbr) {
            var vb = document.createElement('button');
            vb.type = 'button';
            vb.className = 'jita-fm-view' + (JiTA.ui.reporterMode ? ' on' : '');
            vb.textContent = JiTA.ui.reporterMode ? '← Back to similar defects' : '⚑ This reporter’s other reports';
            vb.addEventListener('click', function () {
                JiTA.ui.reporterMode = !JiTA.ui.reporterMode;
                JiTA.ui._closeFilterMenu();
                JiTA.ui._syncFilterBtn();
                JiTA.ui._rerenderCurrent();
            });
            menu.appendChild(vb);
        }

        if (!(onEbr && JiTA.ui.reporterMode)) {
        if (onEbr) {
            var sl = document.createElement('div'); sl.className = 'jita-fm-label'; sl.textContent = 'Status'; menu.appendChild(sl);
            var seg = document.createElement('div'); seg.className = 'jita-fm-seg';
            [['open', 'Open'], ['fixed', 'Closed'], ['all', 'All']].forEach(function (o) {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'jita-fm-segbtn' + (f.status === o[0] ? ' on' : '');
                b.textContent = o[1];
                b.addEventListener('click', function () {
                    JiTA.ui.filters.status = o[0];
                    var bs = seg.querySelectorAll('.jita-fm-segbtn');
                    for (var i = 0; i < bs.length; i++) { bs[i].classList.remove('on'); }
                    b.classList.add('on');
                    JiTA.ui._syncFilterBtn();
                    JiTA.ui._rerenderCurrent();
                });
                seg.appendChild(b);
            });
            menu.appendChild(seg);
        }

        var cl = document.createElement('div'); cl.className = 'jita-fm-label'; cl.textContent = 'Created within'; menu.appendChild(cl);
        var crow = document.createElement('div'); crow.className = 'jita-fm-created';
        var inp = document.createElement('input');
        inp.type = 'number'; inp.min = '0'; inp.className = 'jita-fm-num'; inp.placeholder = 'any';
        inp.value = f.createdDays > 0 ? String(f.createdDays) : '';
        var unit = document.createElement('span'); unit.className = 'jita-fm-unit'; unit.textContent = 'days';
        var ct = null;
        function commitDays() {
            var v = parseInt(inp.value, 10);
            JiTA.ui.filters.createdDays = (!isNaN(v) && v > 0) ? v : 0;
            JiTA.ui._syncFilterBtn();
            JiTA.ui._rerenderCurrent();
        }
        inp.addEventListener('input', function () { if (ct) { clearTimeout(ct); } ct = setTimeout(commitDays, 250); });
        inp.addEventListener('change', commitDays);
        crow.appendChild(inp);
        crow.appendChild(unit);
        [7, 30, 90].forEach(function (n) {
            var p = document.createElement('button'); p.type = 'button'; p.className = 'jita-fm-chip'; p.textContent = n + 'd';
            p.addEventListener('click', function () { inp.value = String(n); commitDays(); });
            crow.appendChild(p);
        });
        menu.appendChild(crow);

        var reset = document.createElement('button');
        reset.type = 'button'; reset.className = 'jita-fm-reset'; reset.textContent = 'Reset filters';
        reset.addEventListener('click', function () {
            JiTA.ui.filters = { status: 'all', createdDays: 0 };
            JiTA.ui._closeFilterMenu();
            JiTA.ui._syncFilterBtn();
            JiTA.ui._rerenderCurrent();
        });
        menu.appendChild(reset);
        }   // end !reporterMode (ranking filters hidden while showing the reporter's other reports)

        document.body.appendChild(menu);
        // Position under the funnel, clamped to the viewport (flip above if it would overflow the bottom).
        var r = anchor.getBoundingClientRect();
        var mw = menu.offsetWidth, mh = menu.offsetHeight;
        var left = Math.min(r.left, window.innerWidth - mw - 6);
        var top = r.bottom + 4;
        if (top + mh > window.innerHeight - 6) { top = r.top - mh - 4; }
        menu.style.left = Math.max(6, left) + 'px';
        menu.style.top = Math.max(6, top) + 'px';
        // Dismiss on outside click / Esc (registered next tick so the opening click doesn't self-close; the
        // funnel itself is excluded so its click handler can toggle the menu shut).
        JiTA.ui._filterMenuDismiss = function (e) {
            if (e.type === 'keydown') { if (e.key === 'Escape') { JiTA.ui._closeFilterMenu(); } return; }
            if (menu.contains(e.target) || (anchor && anchor.contains && anchor.contains(e.target))) { return; }
            JiTA.ui._closeFilterMenu();
        };
        setTimeout(function () {
            document.addEventListener('mousedown', JiTA.ui._filterMenuDismiss, true);
            document.addEventListener('keydown', JiTA.ui._filterMenuDismiss, true);
        }, 0);
    },

    _closeFilterMenu: function () {
        var m = document.getElementById('jita-sd-filtermenu');
        if (m && m.parentNode) { m.parentNode.removeChild(m); }
        if (JiTA.ui._filterMenuDismiss) {
            document.removeEventListener('mousedown', JiTA.ui._filterMenuDismiss, true);
            document.removeEventListener('keydown', JiTA.ui._filterMenuDismiss, true);
            JiTA.ui._filterMenuDismiss = null;
        }
    },

    // Soft-refresh the open issue after a "Mark dup": patch the status lozenge text in place instead of a
    // full page reload (Jira's SPA exposes no clean "refetch this issue" hook). Mirrors how the GM / Close
    // buttons update fields in the DOM. Returns true if it found and updated the status; false otherwise so
    // the caller can fall back to a full reload. (The new duplicate link is created server-side and shows in
    // the Linked Issues section on the next natural refresh.)
    softRefreshStatus: function (statusName) {
        if (!statusName) { return false; }
        var $wrap = $("div[data-testid='issue.views.issue-base.foundation.status.status-field-wrapper']");
        var $btn = $wrap.find('button').first();
        if (!$btn.length) { return false; }
        // The lozenge renders the status as a leaf text node inside the trigger button; replace it.
        var $leaf = $btn.find('*').filter(function () { return this.children.length === 0 && $.trim(this.textContent).length; }).first();
        if ($leaf.length) { $leaf.text(statusName); } else { $btn.text(statusName); }
        return true;
    },

    // Feature C: a styled hover card for a suggestion. Shows the key + summary, status/resolution/stale note,
    // and the full description (which includes the reproduction steps), positioned beside the hovered row and
    // clamped to the viewport. Richer + wider than a native title tooltip, and scrollable for long text.
    // Place the (already-populated) tip beside the anchor row: prefer the left of the panel, flip to the
    // right if there isn't room, and clamp vertically so it never spills off-screen. Re-run after the
    // formatted description loads, since the height changes.
    _positionTip: function ($tip, anchor) {
        $tip.css({ display: 'block', visibility: 'hidden' });
        var el = $tip[0], rect = anchor.getBoundingClientRect();
        var tipW = el.offsetWidth, tipH = el.offsetHeight;
        var left = rect.left - tipW - 10;
        if (left < 6) { left = rect.right + 10; }
        if (left + tipW > window.innerWidth - 6) { left = Math.max(6, window.innerWidth - tipW - 6); }
        var top = rect.top;
        if (top + tipH > window.innerHeight - 6) { top = window.innerHeight - tipH - 6; }
        if (top < 6) { top = 6; }
        $tip.css({ left: left + 'px', top: top + 'px', visibility: 'visible' });
    },

    // Fetch (and cache) the issue's description as Jira-RENDERED HTML, so the hover card keeps the original
    // formatting (paragraphs, lists, code blocks) instead of the flattened single-line text we store for
    // ranking. Same-origin GET with the session cookie. Resolves to an HTML string ('' if none); a network
    // failure resolves '' WITHOUT caching so the next hover retries.
    _renderedCache: {},
    _getRendered: function (key) {
        if (Object.prototype.hasOwnProperty.call(JiTA.ui._renderedCache, key)) {
            return Promise.resolve(JiTA.ui._renderedCache[key]);
        }
        return new Promise(function (resolve) {
            $.ajax({ url: JiTA.HOST + '/rest/api/2/issue/' + key + '?fields=description&expand=renderedFields', dataType: 'json' })
                .done(function (d) {
                    var html = (d && d.renderedFields && d.renderedFields.description) || '';
                    JiTA.ui._renderedCache[key] = html;
                    resolve(html);
                })
                .fail(function () { resolve(''); });
        });
    },

    // Feature C: a styled hover card for a suggestion. Shows the key + summary + status/resolution/stale note,
    // and the defect description WITH its original formatting (fetched as rendered HTML from Jira). The
    // flattened stored text is shown instantly as a placeholder, then upgraded to the formatted version when
    // the fetch returns. _tipKey guards the async swap so a slow fetch can't replace a tip we've moved off of.
    _tipKey: null,
    _showTip: function (r, anchor, meta) {
        JiTA.ui.injectCss();
        JiTA.ui._tipKey = r.key;
        var $tip = $('#jita-sd-tip');
        if (!$tip.length) { $tip = $('<div id="jita-sd-tip"></div>').appendTo(document.body); }
        $tip.empty();
        JiTA.ui._watchMedia($tip[0]);   // arm the media killer for this tip (catches Jira's async hydration)
        $('<div class="jita-sd-tip-title"></div>').text(r.key + ' - ' + (r.summary || '')).appendTo($tip);
        if (meta) { $('<div class="jita-sd-tip-meta"></div>').text(meta).appendTo($tip); }
        var $desc = $('<div class="jita-sd-tip-desc"></div>').appendTo($tip);

        function paintHtml($el, htmlStr) {
            // Jira's own rendered HTML; strip any <script>/<style> defensively before injecting.
            var clean = String(htmlStr).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
            // Strip embedded media AT THE STRING LEVEL so the resource never enters the DOM / starts loading.
            // Jira server-renders an attached video as a legacy <object type="video/mp4">…<embed></object>
            // (confirmed from renderedFields), which the browser autoplays. Replace those whole blocks - plus
            // any <video>/<audio>/<iframe> - with a static placeholder before injecting. (_killMedia below is
            // the belt-and-suspenders DOM pass for any other media shape, e.g. SDK-hydrated data-media nodes.)
            var MEDIA_PH = '<div class="jita-sd-tip-media">▶ media - open the issue to view</div>';
            clean = clean
                .replace(/<object\b[\s\S]*?<\/object>/gi, MEDIA_PH)
                .replace(/<(video|audio|iframe)\b[\s\S]*?<\/\1>/gi, MEDIA_PH)
                .replace(/<(?:video|audio|iframe|embed|source)\b[^>]*\/?>/gi, '');   // stray self-closing/void media tags
            $el.removeClass('jita-sd-tip-dim').addClass('jita-sd-tip-html').html(clean);
            JiTA.ui._killMedia($tip[0]);   // belt-and-suspenders DOM pass (covers SDK-hydrated media, etc.)
        }

        var cached = JiTA.ui._renderedCache[r.key];
        if (typeof cached === 'string') {
            if (cached) { paintHtml($desc, cached); }
            else { $desc.addClass('jita-sd-tip-dim').text('(no description)'); }
            JiTA.ui._positionTip($tip, anchor);
            return;
        }

        // Placeholder: the flattened stored text, shown immediately so there's no hover lag.
        var flat = (r.description || '').replace(/\s+/g, ' ').trim();
        if (flat) { $desc.text(flat); } else { $desc.addClass('jita-sd-tip-dim').text('Loading…'); }
        JiTA.ui._positionTip($tip, anchor);

        JiTA.ui._getRendered(r.key).then(function (htmlStr) {
            if (JiTA.ui._tipKey !== r.key) { return; }   // mouse moved to another row already
            var $live = $('#jita-sd-tip');
            var $d = $live.find('.jita-sd-tip-desc');
            if (!$d.length) { return; }
            if (htmlStr) { paintHtml($d, htmlStr); }
            else if (!flat) { $d.addClass('jita-sd-tip-dim').text('(no description)'); }
            JiTA.ui._positionTip($live, anchor);
        });
    },

    _hideTip: function () {
        JiTA.ui._tipKey = null;
        if (JiTA.ui._tipMediaObs) { try { JiTA.ui._tipMediaObs.disconnect(); } catch (e) { /* ignore */ } JiTA.ui._tipMediaObs = null; }
        $('#jita-sd-tip').css('display', 'none');
    },

    // Strip any playing / hydratable media from the hover card, replacing each with a static placeholder.
    // Covers actual players (<video>/<audio>/<iframe>) AND Atlassian's media PLACEHOLDER nodes (data-media-*
    // / data-node-type="media"): the page's media SDK observes document.body and hydrates those placeholders
    // into autoplaying players AFTER we inject - so removing the placeholder is what actually stops it. The
    // tooltip is pointer-events:none, so an interactive player there is useless anyway. Returns nothing.
    _killMedia: function (root) {
        if (!root) { return; }
        // Recognize a media element broadly. The exact selector kept missing it: Jira wraps an embedded
        // video in nodes like data-node-type="mediaSingle" / data-testid="media-card-view", and the live
        // <video> the SDK hydrates can sit inside a wrapper carrying none of one fixed attribute. So match by
        // tag, by ANY data-media* attribute, by a data-node-type containing "media", or by a "media" class.
        function isMedia(el) {
            if (!el || el.nodeType !== 1 || el === root) { return false; }
            var tag = (el.tagName || '').toLowerCase();
            if (tag === 'video' || tag === 'audio' || tag === 'iframe' || tag === 'object' || tag === 'embed') { return true; }
            var cls = (typeof el.className === 'string') ? el.className : '';
            if (/jita-sd-tip-media/.test(cls)) { return false; }   // our own placeholder - never re-process
            if (/\bmedia/i.test(cls)) { return true; }
            var nt = el.getAttribute && el.getAttribute('data-node-type');
            if (nt && /media/i.test(nt)) { return true; }
            var at = el.attributes;
            if (at) { for (var k = 0; k < at.length; k++) { if (/^data-media/i.test(at[k].name)) { return true; } } }
            return false;
        }
        var all = root.querySelectorAll('*'), targets = [], i;
        for (i = 0; i < all.length; i++) { if (isMedia(all[i])) { targets.push(all[i]); } }
        for (i = 0; i < targets.length; i++) {
            var el = targets[i];
            if (!root.contains(el)) { continue; }   // already removed along with an ancestor media node
            // Replace the OUTERMOST media wrapper (not an inner <video>) so the SDK has no placeholder left
            // to re-hydrate into a new player.
            var top = el, p = el.parentNode;
            while (p && p !== root && isMedia(p)) { top = p; p = p.parentNode; }
            try { if (top.pause) { top.pause(); } } catch (e) { /* ignore */ }
            var ph = document.createElement('div');
            ph.className = 'jita-sd-tip-media';
            ph.textContent = '▶ media - open the issue to view';
            if (top.parentNode) { top.parentNode.replaceChild(ph, top); }
        }
    },

    // Arm a short-lived MutationObserver on the tip so media the page's SDK injects LATER (async hydration)
    // is also stripped. Our placeholder divs don't match _killMedia's selector, so this can't loop. Auto-
    // disconnects after a few seconds (hydration is near-instant) and on _hideTip.
    _tipMediaObs: null,
    _watchMedia: function (root) {
        if (JiTA.ui._tipMediaObs) { try { JiTA.ui._tipMediaObs.disconnect(); } catch (e) { /* ignore */ } JiTA.ui._tipMediaObs = null; }
        if (!root || typeof MutationObserver !== 'function') { return; }
        var obs = new MutationObserver(function () { JiTA.ui._killMedia(root); });
        try { obs.observe(root, { childList: true, subtree: true }); } catch (e) { return; }
        JiTA.ui._tipMediaObs = obs;
        setTimeout(function () { if (JiTA.ui._tipMediaObs === obs) { obs.disconnect(); JiTA.ui._tipMediaObs = null; } }, 5000);
    },

    POS_KEY: 'sdPanelPos',         // GM flag holding the user's chosen panel position { left, top }
    COLLAPSE_KEY: 'sdPanelCollapsed',  // GM flag holding whether the panel is minimized (collapsed)

    // True while an attachment is open in Jira's full-screen media viewer (image / video / PDF / log file).
    // The viewer renders in a high z-index portal but the panel sat on top of it, so we hide the panel while
    // a viewer is open and show it again when it closes. We detect it via the media-viewer testids AND via
    // our own injected log-parser UI (#gpanel), which lives inside that same viewer when a log file is opened.
    _attachmentViewerOpen: function () {
        return !!(
            document.querySelector('[data-testid="media-viewer-popup"]') ||
            document.querySelector('[data-testid="media-viewer-navigation-allotment"]') ||
            document.querySelector('[data-testid="media-viewer"]') ||
            document.getElementById('gpanel')
        );
    },

    // Hide the panel while an attachment viewer is open; restore it (back to its CSS display:flex) afterwards.
    updateVisibility: function () {
        var $p = $('#jita-sd-panel');
        if (!$p.length) { return; }
        if (JiTA.ui._attachmentViewerOpen()) { $p.css('display', 'none'); }
        else if ($p.css('display') === 'none') { $p.css('display', ''); }
    },

    // Apply a saved {left, top} to the panel, clamped so it always stays on-screen (the window may be
    // smaller than when the position was saved). Switching to left/top overrides the default right/bottom
    // anchoring from the CSS. A null/invalid saved value leaves the default bottom-right placement alone.
    _applyPos: function ($p) {
        var pos = null;
        pos = gmGet(JiTA.ui.POS_KEY, null);
        if (!pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') { return; }
        var el = $p[0];
        var w = el.offsetWidth || 340, h = el.offsetHeight || 60;
        var maxLeft = Math.max(0, window.innerWidth - w);
        var maxTop = Math.max(0, window.innerHeight - h);
        var left = Math.min(Math.max(0, pos.left), maxLeft);
        var top = Math.min(Math.max(0, pos.top), maxTop);
        $p.css({ left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' });
        el._jitaTop = top;                 // remember the intended top so _fitVertical can re-anchor on expand
        JiTA.ui._fitVertical();
    },

    // Keep the (expanded) panel on-screen vertically. When the panel is positioned by a dragged/saved top
    // and the expanded panel would run off the BOTTOM of the viewport, flip to "drop-up": pin it by the
    // bottom and reverse the column so the title bar stays put and the list grows UPWARD above it (height
    // capped to the room above so its top never leaves the screen). Only acts when we manage the position
    // via top (user dragged it, or a saved position was restored); the default bottom-anchored placement
    // already grows upward correctly and is left untouched.
    _fitVertical: function () {
        var $p = $('#jita-sd-panel');
        if (!$p.length) { return; }
        var el = $p[0];
        if (typeof el._jitaTop !== 'number') { return; }
        if ($p.hasClass('collapsed')) {                 // collapsed: just keep the title at the intended top
            $p.removeClass('jita-sd-up');
            el.style.maxHeight = '';
            el.style.bottom = 'auto';
            el.style.top = el._jitaTop + 'px';
            return;
        }
        var margin = 8, vh = window.innerHeight;
        // Reset to a plain top-anchored layout to measure the full expanded height at the intended top.
        $p.removeClass('jita-sd-up');
        el.style.maxHeight = '';
        el.style.bottom = 'auto';
        el.style.top = el._jitaTop + 'px';
        var headEl = $p.find('#jita-sd-head')[0];
        var headerH = headEl ? headEl.offsetHeight : 36;
        var fullH = el.offsetHeight;
        if (el._jitaTop + fullH <= vh - margin) { return; }   // fits growing down -> keep the normal layout
        // Would overflow the bottom -> drop up: pin the panel bottom at the header's bottom edge.
        var headerBottom = el._jitaTop + headerH;
        el.style.top = 'auto';
        el.style.bottom = (vh - headerBottom) + 'px';
        el.style.maxHeight = Math.max(80, Math.min(Math.round(vh * 0.52), headerBottom - margin)) + 'px';
        $p.addClass('jita-sd-up');
    },

    // Make the panel draggable by its header. Persists the final position to GM storage on drop so it is
    // restored on the next page load. The collapse "–" control is excluded so clicking it still toggles.
    _makeDraggable: function ($p) {
        var el = $p[0];
        var $head = $p.find('#jita-sd-head');
        var dragging = false, startX = 0, startY = 0, baseLeft = 0, baseTop = 0;

        // We drag by the HEADER's intended top (el._jitaTop) and let _fitVertical decide, on every move,
        // whether the list grows down (room below) or flips to "drop-up" (no room) - so the flip happens
        // live while dragging, not only on release. The header top is clamped by the header height (not the
        // full panel height) so the header can be moved right down to the bottom edge to trigger drop-up.
        function onMove(e) {
            if (!dragging) { return; }
            var w = el.offsetWidth;
            var headEl = $head[0];
            var headerH = headEl ? headEl.offsetHeight : 36;
            var left = Math.min(Math.max(0, baseLeft + (e.clientX - startX)), Math.max(0, window.innerWidth - w));
            var top = Math.min(Math.max(0, baseTop + (e.clientY - startY)), Math.max(0, window.innerHeight - headerH));
            el.style.left = left + 'px';
            el.style.right = 'auto';
            el._jitaTop = top;                 // _fitVertical sets top/bottom from this (anchor or drop-up)
            JiTA.ui._fitVertical();
            e.preventDefault();
        }
        function onUp() {
            if (!dragging) { return; }
            dragging = false;
            $p.removeClass('jita-sd-dragging');
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('mouseup', onUp, true);
            var rect = el.getBoundingClientRect();
            var top = (typeof el._jitaTop === 'number') ? el._jitaTop : Math.round(rect.top);
            gmSet(JiTA.ui.POS_KEY, { left: Math.round(rect.left), top: top });
            JiTA.ui._fitVertical();
        }
        $head.on('mousedown', function (e) {
            if (e.which && e.which !== 1) { return; }                 // left button only
            if ($(e.target).closest('#jita-sd-collapse').length) { return; }  // let the collapse toggle work
            if ($(e.target).closest('#jita-sd-filter').length) { return; }    // let the filter input take focus / select text
            if ($(e.target).closest('#jita-sd-filterbtn').length) { return; } // let the funnel open the filter popover
            if ($(e.target).closest('#jita-sd-mode').length) { return; }      // let the mode badge toggle ranking
            // Drag relative to the HEADER's current top (works whether we're top-anchored or in drop-up),
            // so the header tracks the cursor and _fitVertical re-evaluates up/down on every move.
            var hTop = $head[0].getBoundingClientRect().top;
            baseLeft = el.getBoundingClientRect().left; baseTop = hTop;
            el._jitaTop = hTop;
            startX = e.clientX; startY = e.clientY;
            dragging = true;
            $p.addClass('jita-sd-dragging');
            document.addEventListener('mousemove', onMove, true);
            document.addEventListener('mouseup', onUp, true);
            e.preventDefault();
        });
    },

    // Panel style: 'sidebar' (default - integrated into Jira's context column, between Details and
    // Development) or 'floating' (the original draggable box on document.body). Persisted in GM 'sdPanelStyle'.
    mode: function () {
        return (gmGet('sdPanelStyle', 'sidebar') === 'floating') ? 'floating' : 'sidebar';
    },

    // Flip the panel style and re-mount in the new location (no reload). Called from the settings overlay.
    toggleStyle: function () {
        var next = (JiTA.ui.mode() === 'sidebar') ? 'floating' : 'sidebar';
        gmSet('sdPanelStyle', next);
        $('#jita-sd-panel').remove();
        $('#jita-side-group').remove();
        if (JiTA.ui.currentKey && /^EBR-/.test(JiTA.ui.currentKey)) { JiTA.ui.render(JiTA.ui.currentKey); }
        else if (JiTA.ui.currentKey && JiTA.ui._isReportsKey(JiTA.ui.currentKey)) { JiTA.ui.renderReports(JiTA.ui.currentKey); }
        refreshMenu();
    },

    // True once the panel chrome (specifically its shared inner list) is mounted in EITHER location. Used by
    // ensure() to decide whether a (re)render is needed - in sidebar mode Jira's React re-renders can wipe
    // our injected section, and this flips back to false so the observer re-mounts + repopulates it.
    _chromePresent: function () { return !!document.getElementById('jita-sd-list'); },

    // SVG chevron matching Jira's native context-group caret (points down when expanded; CSS rotates it -90°
    // when collapsed). Same path Jira uses for its Details / Development group headers.
    _chevronSvg: '<svg fill="none" viewBox="-8 -8 32 32" width="16" height="16" role="presentation"><path fill="currentColor" d="m14.53 6.03-6 6a.75.75 0 0 1-1.004.052l-.056-.052-6-6 1.06-1.06L8 10.44l5.47-5.47z"></path></svg>',

    // The two chevron path shapes Jira uses (it swaps the path rather than rotating): down caret when the
    // group is open, right caret when collapsed.
    _CHEV_DOWN: 'm14.53 6.03-6 6a.75.75 0 0 1-1.004.052l-.056-.052-6-6 1.06-1.06L8 10.44l5.47-5.47z',
    _CHEV_RIGHT: 'm6.03 1.47 6 6a.75.75 0 0 1 .052 1.004l-.052.056-6 6-1.06-1.06L10.44 8 4.97 2.53z',

    // Point the group's chevron the right way (open = down, collapsed = right). Works for both the cloned
    // native chevron and the hand-built one (both carry [data-jita-chevron]).
    _setChevron: function (group, collapsed) {
        var p = group && group.querySelector('[data-jita-chevron] path');
        if (p) { p.setAttribute('d', collapsed ? JiTA.ui._CHEV_RIGHT : JiTA.ui._CHEV_DOWN); }
    },

    // Ensure the panel chrome (shared inner ids: #jita-sd-title, #jita-sd-mode, #jita-sd-status, #jita-sd-loglink,
    // #jita-sd-list) exists in the active location. Sidebar by default; falls back to the floating box if the
    // Jira context column / Details anchor isn't in the DOM (yet).
    _ensurePanel: function () {
        JiTA.ui.injectCss();
        JiTA.ui._wireFilter();   // bind the mode-badge click + window-level filter guards once
        if (JiTA.ui.mode() === 'sidebar' && JiTA.ui._ensureSidebar()) {
            if ($('#jita-sd-panel').length) { $('#jita-sd-panel').remove(); }   // drop a lingering floating box
            return;
        }
        if ($('#jita-side-group').length) { $('#jita-side-group').remove(); }   // floating mode / no sidebar anchor
        JiTA.ui._ensureFloating();
    },

    // The original floating, draggable panel on document.body (now opt-in / the fallback when the sidebar
    // anchor is missing). Lives outside Jira's React tree, so it survives re-renders without re-mounting.
    _ensureFloating: function () {
        if ($('#jita-sd-panel').length) { return; }
        var $p = $(
            '<div id="jita-sd-panel">' +
            '  <div id="jita-sd-head"><span id="jita-sd-title">Similar defects</span>' +
            '    <input id="jita-sd-filter" type="text" placeholder="Filter…" autocomplete="off" title="Filter the whole database by this text (key / title / description) and show the best matches">' +
            '    <span id="jita-sd-filterbtn" title="Filter results (status / recency)">' + JiTA.ui._funnelSvg + '</span>' +
            '    <span id="jita-sd-mode" title="Click to switch ranking mode (resets to automatic on reload)">Keyword</span>' +
            '    <span id="jita-sd-collapse" title="Collapse / expand">–</span></div>' +
            '  <div id="jita-sd-status"></div>' +
            '  <div id="jita-sd-loglink"></div>' +
            '  <div id="jita-sd-exccluster"></div>' +
            '  <ul id="jita-sd-list"></ul>' +
            '</div>'
        );
        // Restore the saved minimized state before showing the panel.
        var collapsed = false;
        collapsed = !!gmGet(JiTA.ui.COLLAPSE_KEY, false);
        if (collapsed) { $p.addClass('collapsed'); }
        $p.find('#jita-sd-collapse').text(collapsed ? '+' : '–');
        $p.find('#jita-sd-collapse').on('click', function () {
            var isCollapsed = $('#jita-sd-panel').toggleClass('collapsed').hasClass('collapsed');
            $(this).text(isCollapsed ? '+' : '–');   // reflect state in the control
            gmSet(JiTA.ui.COLLAPSE_KEY, isCollapsed);
            JiTA.ui._fitVertical();   // on expand, grow upward if there's no room below; on collapse, reset
        });
        $p.appendTo(document.body);
        JiTA.ui._applyPos($p);          // restore the user's saved position (if any)
        JiTA.ui._makeDraggable($p);     // wire up header dragging
        JiTA.ui.updateVisibility();     // stay hidden if an attachment viewer is already open
    },

    // Mount (or verify) the integrated "Triage Assistant" group in Jira's context column, immediately after
    // the Details group (so it sits between Details and Development). Returns true once the chrome (with the
    // shared inner ids) is present, false if the Details anchor isn't in the DOM yet (caller then falls back
    // to the floating box). Cheap fast-path when already mounted, since the observer calls this often.
    SIDE_COLLAPSE_KEY: 'sdSideCollapsed',

    // The inner body of the group (subhead + the shared chrome ids), shared by the clone and manual builders.
    _sidebarBodyHtml: function () {
        return '<div class="jita-side-subhead"><span id="jita-sd-title">Similar defects</span>' +
               '<input id="jita-sd-filter" type="text" placeholder="Filter…" autocomplete="off" title="Filter the whole database by this text (key / title / description) and show the best matches">' +
               '<span id="jita-sd-filterbtn" title="Filter results (status / recency)">' + JiTA.ui._funnelSvg + '</span>' +
               '<span id="jita-sd-mode" title="Click to switch ranking mode (resets to automatic on reload)">Keyword</span></div>' +
               '<div id="jita-sd-status"></div>' +
               '<div id="jita-sd-loglink"></div>' +
               '<div id="jita-sd-exccluster"></div>' +
               '<ul id="jita-sd-list"></ul>';
    },

    // Strip identifying attributes from a cloned subtree so it can't shadow Jira's own (or our) data-testid /
    // data-vc / id lookups. Class names + inline styles (which carry all the visual styling) are kept.
    _stripAttrs: function (root) {
        var nodes = root.querySelectorAll('*'), i;
        for (i = 0; i < nodes.length; i++) {
            nodes[i].removeAttribute('data-testid');
            nodes[i].removeAttribute('data-vc');
            nodes[i].removeAttribute('data-component-selector');
            if (nodes[i].id) { nodes[i].removeAttribute('id'); }
        }
        root.removeAttribute('data-testid');
        root.removeAttribute('data-vc');
        root.removeAttribute('data-component-selector');
    },

    _ensureSidebar: function () {
        if (document.getElementById('jita-side-group') && document.getElementById('jita-sd-list')) { return true; }
        // The Details slot is our anchor (data-vc is stable; the atomic class names are not). Fall back to the
        // details-group container if the slot wrapper isn't present.
        var anchor = document.querySelector('[data-vc="issue-view-context-items-details-panel-slot"]')
            || document.querySelector('[data-vc="issue-view-context-group-details-group"]');
        if (!anchor || !anchor.parentNode) { return false; }

        // Drop a stale wrapper React may have left behind (body wiped but shell kept) before re-mounting.
        var old = document.getElementById('jita-side-group');
        if (old && old.parentNode) { old.parentNode.removeChild(old); }

        var collapsed = false;
        collapsed = !!gmGet(JiTA.ui.SIDE_COLLAPSE_KEY, false);

        var group = null, headerClickTarget = null;

        // Preferred: CLONE a real context group so the card chrome / header / chevron / title font match Jira
        // exactly. Prefer a NON-Details group (Development / More fields) - its header padding + chevron
        // position are what the user wants to match; the Details group is the always-open "primary" group with
        // slightly different header padding. We clone the group's inner wrapper (it stays in the DOM even when
        // collapsed - the body content just sits in a hidden div), gut the body, drop our content in, strip the
        // clone's identifying attributes, point the chevron the right way, and re-wire the collapse toggle (the
        // clone is static DOM with no React handlers). Marked with [data-jita-body] / [data-jita-chevron].
        var tmpl = null;
        var inners = document.querySelectorAll('[data-vc^="issue-view-context-group-"][data-vc$="-inner"]');
        for (var ti = 0; ti < inners.length; ti++) {
            if (!/details/i.test(inners[ti].getAttribute('data-vc') || '')) { tmpl = inners[ti]; break; }
        }
        if (!tmpl) {
            // No other group present (rare) -> fall back to the Details group's inner, then its container.
            tmpl = document.querySelector('[data-vc="issue-view-context-group-details-group-inner"]')
                || document.querySelector('[data-vc="issue-view-context-group-details-group"]');
        }
        if (tmpl) {
            try {
                var clone = tmpl.cloneNode(true);
                var titleEl = clone.querySelector('[data-testid$="collapsible-group-factory.title"]') || clone.querySelector('h2');
                var bodyEl = clone.querySelector('[data-vc$="-body"]');
                var chevronEl = clone.querySelector('[data-vc="issue-view-group-chevron"]');
                var btnEl = clone.querySelector('[role="button"]');
                if (titleEl && bodyEl && bodyEl.parentNode) {
                    JiTA.ui._stripAttrs(clone);                 // (keeps element refs above valid)
                    if (chevronEl) { chevronEl.setAttribute('data-jita-chevron', '1'); }
                    titleEl.textContent = 'Triage Assistant';
                    // We cloned a COLLAPSED group, whose body wrapper carries Jira's collapse machinery (a
                    // `hidden` attribute, a nested `<div hidden>`, and/or inline height:0 / overflow on
                    // wrappers) that survives the clone and keeps content invisible even when expanded.
                    // Rather than try to undo all of that, throw the cloned body wrapper away entirely and
                    // drop in a clean, baggage-free body element in its place. Our own `.collapsed` class is
                    // then the only thing that hides/shows it.
                    var freshBody = document.createElement('div');
                    freshBody.setAttribute('data-jita-body', '1');
                    freshBody.className = 'jita-side-body';
                    freshBody.innerHTML = JiTA.ui._sidebarBodyHtml();
                    var bodyParent = bodyEl.parentNode;
                    bodyParent.replaceChild(freshBody, bodyEl);
                    // The cloned group was COLLAPSED, so its body is suppressed by the wrapper's collapse
                    // state. Jira drives that with an `[open]` ATTRIBUTE, not inline styles: the rule
                    // `._1jl4glyw:not([open]) > div { display: none }` hides the body whenever the wrapper
                    // lacks `open`. (It may also leave a `hidden` attribute / inline height:0 from the
                    // animation.) The header sits outside that wrapper so it still shows. Walk from the body's
                    // wrapper up to the group root and force every wrapper OPEN + clear any leftover collapse
                    // styling, so our own `.collapsed` class is the only thing that hides/shows the content.
                    for (var node = freshBody.parentNode; node && node !== clone; node = node.parentNode) {
                        node.setAttribute('open', '');
                        node.removeAttribute('hidden');
                        if (node.style && node.style.setProperty) {
                            // Use !important: the collapse clip / spacing / transform can come from the
                            // wrapper's CLASS (the `_1jl4glyw` height-animation), not just an inline style, so a
                            // plain reset loses to it and the body gets clipped to a sliver (the "gap at the
                            // top" with content squished). Forcing natural height + visible overflow + zero
                            // spacing/transform here makes our `.collapsed` class the only thing that hides it.
                            node.style.setProperty('height', 'auto', 'important');
                            node.style.setProperty('max-height', 'none', 'important');
                            node.style.setProperty('min-height', '0', 'important');
                            node.style.setProperty('overflow', 'visible', 'important');
                            node.style.setProperty('opacity', '1', 'important');
                            node.style.setProperty('visibility', 'visible', 'important');
                            node.style.setProperty('transform', 'none', 'important');
                            node.style.setProperty('transition', 'none', 'important');
                            // Neutralize positioning: a cloned wrapper can carry position+top (e.g. a
                            // <section> with `top: 49px`) that offsets the whole body down and shows as the
                            // intermittent "gap at the top". Force it back to static flow.
                            node.style.setProperty('position', 'static', 'important');
                            node.style.setProperty('top', 'auto', 'important');
                            // Zero the wrapper's own spacing (the clone ROOT keeps the card's outer padding;
                            // freshBody keeps its own) so the body sits flush under the header.
                            node.style.setProperty('padding', '0', 'important');
                            node.style.setProperty('margin', '0', 'important');
                        }
                    }
                    if (clone.setAttribute) { clone.setAttribute('open', ''); }   // in case the clone root itself is the [open] toggle
                    // Normalize the HEADER's spacing too. The intermittent "gap at the top" came from cloning
                    // whichever non-Details group happened to be first in the DOM that reload (Development /
                    // More fields / Releases…): each ships a slightly different header top-padding, and the
                    // body-wrapper reset above never touched the header. Pin the header wrapper (the clone-root
                    // child that holds the title) to a fixed vertical padding, and zero the clone root's own
                    // top padding, so the top spacing is identical regardless of which group was cloned.
                    var headerWrap = titleEl;
                    while (headerWrap && headerWrap.parentNode && headerWrap.parentNode !== clone) { headerWrap = headerWrap.parentNode; }
                    // headerWrap is the clone-root child (a <section>) that wraps BOTH the header AND the body.
                    // Vertical padding here therefore also shows as an empty gap BELOW the hidden body when
                    // COLLAPSED - the reported "too much space at the bottom". Zero its top/bottom padding (keep
                    // its native horizontal padding) and move the symmetric vertical spacing onto the HEADER ROW
                    // itself (below), so the title is centered when collapsed with no trailing body gap.
                    if (headerWrap && headerWrap !== clone && headerWrap.style && headerWrap.style.setProperty) {
                        headerWrap.style.setProperty('padding-top', '0', 'important');
                        headerWrap.style.setProperty('padding-bottom', '0', 'important');
                        headerWrap.style.setProperty('margin', '0', 'important');
                    }
                    // Symmetric vertical padding on the header row (chevron + title) keeps the title vertically
                    // centered in the collapsed card regardless of which native group was cloned, independent of
                    // the section padding we just zeroed. Top/bottom only - preserve the header's native
                    // horizontal padding so the chevron stays aligned with the card edge.
                    if (btnEl && btnEl.style && btnEl.style.setProperty) {
                        btnEl.style.setProperty('padding-top', '8px', 'important');
                        btnEl.style.setProperty('padding-bottom', '8px', 'important');
                    }
                    // Zero the clone root's own top AND bottom padding. The bottom one is what left a big empty
                    // gap under the title when COLLAPSED (the body is hidden, but the card kept its padding); the
                    // expanded view gets its bottom spacing from the body's own padding-bottom instead.
                    if (clone.style && clone.style.setProperty) {
                        clone.style.setProperty('padding-top', '0', 'important');
                        clone.style.setProperty('padding-bottom', '0', 'important');
                    }
                    // The actual culprit behind the intermittent top gap: a cloned <section> carries an inline
                    // `top: 49px` (a positioned offset that survives the clone). Sweep EVERY section in the
                    // clone - not just the body-wrapper chain - back to static flow so nothing is pushed down.
                    var jitaSecs = clone.querySelectorAll('section');
                    for (var jitaSi = 0; jitaSi < jitaSecs.length; jitaSi++) {
                        var sec = jitaSecs[jitaSi];
                        if (sec.style && sec.style.setProperty) {
                            sec.style.setProperty('position', 'static', 'important');
                            sec.style.setProperty('top', 'auto', 'important');
                        }
                    }
                    clone.id = 'jita-side-group';
                    clone.classList.add('jita-ta-native');
                    headerClickTarget = btnEl || clone;
                    group = clone;
                }
            } catch (e) { group = null; }
        }

        // Fallback: hand-built group (used only if the native template wasn't found / clone failed).
        if (!group) {
            var $g = $(
                '<div id="jita-side-group" class="jita-ta-manual">' +
                '  <div id="jita-side-header" role="button" tabindex="0" aria-expanded="true">' +
                '    <span class="jita-side-chevron" data-jita-chevron="1">' + JiTA.ui._chevronSvg + '</span>' +
                '    <span class="jita-side-htitle">Triage Assistant</span>' +
                '  </div>' +
                '  <div class="jita-side-body" data-jita-body="1">' + JiTA.ui._sidebarBodyHtml() + '</div>' +
                '</div>'
            );
            group = $g[0];
            headerClickTarget = group.querySelector('#jita-side-header');
        }

        if (collapsed) { group.classList.add('collapsed'); }
        JiTA.ui._setChevron(group, collapsed);   // point the chevron the right way for the initial state

        // Collapse toggle (shared by both paths): reflect on the root class + aria-expanded + chevron, persist.
        if (headerClickTarget) {
            headerClickTarget.style.cursor = 'pointer';
            headerClickTarget.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            headerClickTarget.addEventListener('click', function () {
                var isColl = group.classList.toggle('collapsed');
                JiTA.ui._setChevron(group, isColl);
                try { headerClickTarget.setAttribute('aria-expanded', isColl ? 'false' : 'true'); } catch (e) { /* ignore */ }
                gmSet(JiTA.ui.SIDE_COLLAPSE_KEY, isColl);
                // Drop focus so the cloned button doesn't keep Jira's blue focus ring after the toggle click.
                try { headerClickTarget.blur(); } catch (e3) { /* ignore */ }
            });
            // Belt-and-suspenders: a mousedown focuses the button before click fires, so the ring can flash
            // even with the post-click blur. Suppress the focus on pointer interaction entirely (keyboard
            // focus via Tab still works for accessibility); a plain click then toggles without a lingering ring.
            headerClickTarget.addEventListener('mousedown', function (e) { e.preventDefault(); });
        }

        if (anchor.nextSibling) { anchor.parentNode.insertBefore(group, anchor.nextSibling); }
        else { anchor.parentNode.appendChild(group); }
        return true;
    },

    // Feature B: build a "Mark dup" control that links the open EBR as a duplicate of `defectKey` and moves
    // it to Attached (status + resolution + link in one transition). Shared by the suggestions list AND the
    // "Known defects in attached log" section so both behave identically.
    // ---- hide ("ignore") control: temporarily dismiss a defect ----
    // Eye-off icon (Material "visibility_off"); clicking opens a small duration popover. The chosen hide is
    // persisted by JiTA.hidden (GM storage -> survives script updates) and the ranking layer skips hidden
    // keys, so a hidden defect never takes a result slot. Shown next to each defect in the "Known defects in
    // attached log" list (renderLogLink) - hiding keys on the issue key, so it also drops out of the ranked
    // "Similar defects" suggestions.
    _eyeOffSvg: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"></path></svg>',

    _hideButton: function (key) {
        var $h = $('<span class="jita-sd-hide"></span>')
            .attr('title', 'Hide ' + key + ' from suggestions for a while')
            .html(JiTA.ui._eyeOffSvg);
        $h.on('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            JiTA.ui._showHideMenu(key, this);
        });
        return $h;
    },

    // Small popover anchored to the eye-off icon: pick how long to hide (presets, max 90 days). On choice we
    // persist the hide and re-render the current view so the slot refills from the next-best non-hidden match.
    _showHideMenu: function (key, anchor) {
        JiTA.ui._closeHideMenu();
        JiTA.ui._hideTip();   // don't leave a hover card up behind the popover
        var menu = document.createElement('div');
        menu.id = 'jita-sd-hidemenu';
        var label = document.createElement('div');
        label.className = 'jita-sd-hidemenu-label';
        label.textContent = 'Hide ' + key + ' for…';
        menu.appendChild(label);
        JiTA.hidden.PRESETS.forEach(function (p) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'jita-sd-hidemenu-btn';
            b.textContent = p.label;
            b.addEventListener('click', function (ev) {
                ev.stopPropagation();
                JiTA.hidden.hide(key, p.days);
                JiTA.ui._closeHideMenu();
                JiTA.ui._hideTip();
                JiTA.ui.toast('Hidden ' + key + ' for ' + p.label + '.');
                JiTA.ui._rerenderCurrent();
            });
            menu.appendChild(b);
        });
        document.body.appendChild(menu);
        // Position under the icon, clamped to the viewport (flip above if it would overflow the bottom).
        var r = anchor.getBoundingClientRect();
        var mw = menu.offsetWidth, mh = menu.offsetHeight;
        var left = Math.min(r.left, window.innerWidth - mw - 6);
        var top = r.bottom + 4;
        if (top + mh > window.innerHeight - 6) { top = r.top - mh - 4; }
        menu.style.left = Math.max(6, left) + 'px';
        menu.style.top = Math.max(6, top) + 'px';
        // Dismiss on outside click or Esc (capture phase, registered next tick so the opening click is ignored).
        JiTA.ui._hideMenuDismiss = function (e) {
            if (e.type === 'keydown') { if (e.key === 'Escape') { JiTA.ui._closeHideMenu(); } return; }
            if (menu.contains(e.target)) { return; }
            JiTA.ui._closeHideMenu();
        };
        setTimeout(function () {
            document.addEventListener('mousedown', JiTA.ui._hideMenuDismiss, true);
            document.addEventListener('keydown', JiTA.ui._hideMenuDismiss, true);
        }, 0);
    },

    _closeHideMenu: function () {
        var m = document.getElementById('jita-sd-hidemenu');
        if (m && m.parentNode) { m.parentNode.removeChild(m); }
        if (JiTA.ui._hideMenuDismiss) {
            document.removeEventListener('mousedown', JiTA.ui._hideMenuDismiss, true);
            document.removeEventListener('keydown', JiTA.ui._hideMenuDismiss, true);
            JiTA.ui._hideMenuDismiss = null;
        }
    },

    _markDupButton: function (defectKey) {
        var $dup = $('<span class="jita-sd-link"></span>')
            .text('Attach')
            .attr('title', 'Link this bug report as a duplicate of ' + defectKey);
        $dup.on('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            var $btn = $(this);
            if ($btn.hasClass('jita-sd-linked') || $btn.hasClass('jita-sd-linking')) { return; }
            var ebr = JiTA.ui.currentKey;
            if (!ebr) { return; }
            if (!confirm('Link ' + ebr + ' as a duplicate of ' + defectKey + ' and set it to Attached?')) { return; }
            $btn.addClass('jita-sd-linking').text('…');
            // Single call: the Attached transition sets the status, resolution AND the duplicate link at once.
            JiTA.link.attachDuplicate(ebr, defectKey, 'Attached', 'Duplicate').then(function (res) {
                JiTA.ui._hideTip();
                $btn.removeClass('jita-sd-linking').addClass('jita-sd-linked').text(res.attached ? '✓ attached' : '✓ linked');
                var msg = res.attached
                    ? ('Linked ' + ebr + ' as a duplicate of ' + defectKey + ' and set it to Attached.')
                    : ('Linked ' + ebr + ' as a duplicate of ' + defectKey + ' (could not set Attached).');
                if (!res.linked) { msg = 'Set ' + ebr + ' to Attached, but the duplicate link failed.'; }
                // Soft-patch the status lozenge in place - no full reload. The duplicate link is created
                // server-side and shows in Jira's "Linked work items" section on the next natural refresh.
                if (res.attached) {
                    JiTA.ui.softRefreshStatus('Attached');
                    // Drop the now-Attached report from the local open-report DB immediately so it no longer
                    // shows up as an open match on defects before the next EBR sync prunes it.
                    JiTA.db.deleteDefects([ebr]).then(function () {
                        JiTA.rank._dirtyEbr = true;
                        JiTA.rank._dirtyEbrVec = true;
                    });
                }
                JiTA.ui.toast(msg);
            }, function (e) {
                console.log('[JiTA] mark-dup failed (attachDuplicate rejected):', e && e.message || e);
                $btn.removeClass('jita-sd-linking').text('Attach');
                JiTA.ui.toast('Could not link: ' + (e && e.message || e));
            });
        });
        return $dup;
    },

    // Fetch (and cache per key) a bug report's current assignee. Resolves { accountId, name } when assigned,
    // or null when unassigned; REJECTS on a network failure so the caller can refuse to offer the attach
    // action when it couldn't verify who owns the report.
    _assigneeCache: {},
    _getAssignee: function (key) {
        if (Object.prototype.hasOwnProperty.call(JiTA.ui._assigneeCache, key)) {
            return Promise.resolve(JiTA.ui._assigneeCache[key]);
        }
        return new Promise(function (resolve, reject) {
            $.ajax({ url: JiTA.HOST + '/rest/api/2/issue/' + key + '?fields=assignee', dataType: 'json' })
                .done(function (d) {
                    var a = d && d.fields && d.fields.assignee;
                    var v = a ? { accountId: a.accountId, name: a.displayName || a.name || '' } : null;
                    JiTA.ui._assigneeCache[key] = v;
                    resolve(v);
                })
                .fail(function () { reject(new Error('assignee fetch failed')); });
        });
    },

    // Defect-side mirror of _markDupButton: build an "Attach" control on a matching-bug-report row that links
    // the report (`reportKey`) as a duplicate of the CURRENT defect and moves it to Attached - via the same
    // single transition (status + resolution + link + assignee) as the EBR-side button, just with the report
    // as the issue being transitioned. Triage rule: we only ever attach a report that is UNASSIGNED or already
    // assigned to the current user (never one someone else is working). So the button stays in a muted
    // "checking…" state until we've confirmed the assignee, then either enables ("Attach") or shows a muted,
    // non-clickable "assigned" hint. On attach it also sets the assignee to the current user (matches Jira's
    // native Attach dialog). The assignee can change server-side, so we gate on a LIVE fetch, not stored data.
    _attachReportButton: function (reportKey) {
        var defectKey = JiTA.ui.currentKey;   // the defect this row was rendered for (captured now)
        var $btn = $('<span class="jita-sd-link jita-sd-linking"></span>').text('…')
            .attr('title', 'Checking assignee…');

        function wireAttach() {
            $btn.removeClass('jita-sd-linking jita-sd-noattach').text('Attach')
                .attr('title', 'Attach ' + reportKey + ' to ' + defectKey + ' as a duplicate (sets it to Attached)');
            $btn.on('click', function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                var $b = $(this);
                if ($b.hasClass('jita-sd-linked') || $b.hasClass('jita-sd-linking')) { return; }
                if (!confirm('Attach ' + reportKey + ' to ' + defectKey + ' as a duplicate and set it to Attached?')) { return; }
                $b.addClass('jita-sd-linking').text('…');
                // Pass the current user so the report is assigned to the triager on attach (the gate guarantees
                // it was unassigned or already mine, so this never steals someone else's assignment).
                JiTA.link.currentUser().then(function (me) {
                    return JiTA.link.attachDuplicate(reportKey, defectKey, 'Attached', 'Duplicate', me).then(function (res) {
                        JiTA.ui._hideTip();
                        $b.removeClass('jita-sd-linking').addClass('jita-sd-linked').text(res.attached ? '✓ attached' : '✓ linked');
                        var msg = res.attached
                            ? ('Attached ' + reportKey + ' to ' + defectKey + '.')
                            : ('Linked ' + reportKey + ' to ' + defectKey + ' (could not set Attached).');
                        if (!res.linked) { msg = 'Set ' + reportKey + ' to Attached, but the duplicate link failed.'; }
                        JiTA.ui.toast(msg);
                        // Only remove it once the Attached transition actually succeeded (so it's genuinely
                        // resolved). Drop it from the local open-report DB, mark the EBR indexes dirty, then
                        // collapse/fade its row out (the rows below slide up) and re-render so a fresh
                        // suggestion loads into the freed slot. If only the link was created (status still
                        // open), leave the row in place - the report is still an open match.
                        if (res.attached) {
                            return JiTA.db.deleteDefects([reportKey]).then(function () {
                                JiTA.rank._dirtyEbr = true;
                                JiTA.rank._dirtyEbrVec = true;
                                JiTA.ui._fadeOutAndReplace($b.closest('li'), defectKey);
                            });
                        }
                    });
                }).catch(function (e) {
                    console.log('[JiTA] attach-report failed:', e && e.message || e);
                    $b.removeClass('jita-sd-linking').text('Attach');
                    JiTA.ui.toast('Could not attach: ' + (e && e.message || e));
                });
            });
        }

        // Gate on the report's live assignee: only unassigned or assigned-to-me may be attached.
        Promise.all([JiTA.link.currentUser(), JiTA.ui._getAssignee(reportKey)]).then(function (res) {
            var me = res[0], assignee = res[1];   // assignee: { accountId, name } or null (unassigned)
            if (!assignee || (me && assignee.accountId === me)) {
                wireAttach();
            } else {
                $btn.removeClass('jita-sd-linking').addClass('jita-sd-noattach').text('assigned')
                    .attr('title', 'Assigned to ' + (assignee.name || 'someone else') +
                        ' - only unassigned reports or ones assigned to you can be attached');
            }
        }, function () {
            $btn.remove();   // couldn't determine the assignee -> don't offer the action
        });

        return $btn;
    },

    // After a report is attached from the defect view, animate the change incrementally instead of rebuilding
    // the whole list (which flickered): collapse + fade the attached row out (the rows below slide up into the
    // gap), remove it, then query for ONE fresh candidate not already shown and slide it into the freed last
    // slot. The record is already deleted from the local DB and the EBR indexes marked dirty by the caller, so
    // the re-query no longer returns the attached report. We snapshot the keys still on screen BEFORE the
    // collapse so the new query can pick the best result that isn't already listed.
    _fadeOutAndReplace: function ($li, defectKey) {
        var el = $li && $li[0];
        // Snapshot the keys currently shown (minus the one being removed) so _appendNextReport can find the
        // first ranked result that isn't already on screen.
        var shown = {};
        $('#jita-sd-list').children('li').each(function () {
            var k = this.getAttribute('data-jita-key');
            if (k && this !== el) { shown[k] = true; }
        });
        function appendFresh() {
            if (JiTA.ui.currentKey === defectKey) { JiTA.ui._appendNextReport(defectKey, shown); }
        }
        if (!el) { appendFresh(); return; }
        var h = el.offsetHeight;
        el.style.overflow = 'hidden';
        el.style.maxHeight = h + 'px';
        // Force a reflow so the starting max-height is applied before we transition to 0 (otherwise the
        // browser may collapse the two style writes into one and skip the animation).
        void el.offsetHeight;
        el.style.transition = 'max-height .3s ease, opacity .3s ease, padding .3s ease, margin .3s ease';
        el.style.opacity = '0';
        el.style.maxHeight = '0px';
        el.style.paddingTop = '0px';
        el.style.paddingBottom = '0px';
        el.style.marginTop = '0px';
        el.style.marginBottom = '0px';
        setTimeout(function () {
            if (el.parentNode) { el.parentNode.removeChild(el); }   // drop the collapsed row (rows below have slid up)
            appendFresh();
        }, 320);
    },

    // Query the matching-reports ranking again and slide in the single best result that isn't already on
    // screen (the keys in `shown`), filling the slot freed by the just-attached row. Also refreshes the
    // status-line count + mode. No-op if nothing new ranks (e.g. fewer matches than slots) - the list just
    // ends up one row shorter. Used by _fadeOutAndReplace so we don't rebuild the whole list.
    _appendNextReport: function (defectKey, shown) {
        var terms = JiTA.ui._filterTerms();   // honor the active filter when picking the replacement row
        JiTA.ui.getIssueText(defectKey).then(function (text) {
            if (JiTA.ui.currentKey !== defectKey || !text) { return; }
            return JiTA.rank.suggestEbrBest(text, defectKey, JiTA.ui.modeOverride, terms).then(function (out) {
                if (JiTA.ui.currentKey !== defectKey) { return; }
                var results = out.results || [];
                $('#jita-sd-mode').text(out.mode);
                var pick = null;
                for (var i = 0; i < results.length; i++) {
                    if (!shown[results[i].key]) { pick = results[i]; break; }   // first ranked result not already listed
                }
                function refreshCount() {
                    JiTA.db.countEbr().then(function (n) {
                        if (JiTA.ui.currentKey !== defectKey) { return; }
                        var c = $('#jita-sd-list').children('li').length;
                        JiTA.ui.setStatus(c + ' matches · ' + out.mode + ' · ' + n + ' open reports');
                    });
                }
                if (!pick) { refreshCount(); return; }
                // Enrich with the report's full description + created date (for the hover preview / date row),
                // then build the row and slide it in at the bottom.
                return JiTA.db.getDefect(pick.key).then(function (rec) {
                    if (rec) { pick.description = rec.description; pick.created = rec.created; }
                }, function () { /* ignore */ }).then(function () {
                    if (JiTA.ui.currentKey !== defectKey) { return; }
                    JiTA.ui._slideInRow(JiTA.ui._reportItem(pick), $('#jita-sd-list'));
                    refreshCount();
                });
            });
        }).catch(function (e) { console.log('[JiTA] append-next-report skipped:', e && e.message || e); });
    },

    // Append a freshly-built row to the list and animate it sliding/expanding in from a collapsed state. We
    // measure the row's natural height (and padding/margins) first, then start it collapsed and transition to
    // those values; once the transition ends we clear the inline animation styles so the row sits in fully
    // natural layout (important for the responsive grid, where a leftover max-height would clip a taller card).
    _slideInRow: function ($row, $list) {
        var el = $row[0];
        $list.append($row);
        var cs = window.getComputedStyle(el);
        var full = el.offsetHeight;
        var padTop = cs.paddingTop, padBot = cs.paddingBottom, marTop = cs.marginTop, marBot = cs.marginBottom;
        el.style.overflow = 'hidden';
        el.style.maxHeight = '0px';
        el.style.opacity = '0';
        el.style.paddingTop = '0px';
        el.style.paddingBottom = '0px';
        el.style.marginTop = '0px';
        el.style.marginBottom = '0px';
        void el.offsetHeight;   // reflow at the collapsed start so the transition actually runs
        el.style.transition = 'max-height .3s ease, opacity .3s ease, padding .3s ease, margin .3s ease';
        el.style.maxHeight = full + 'px';
        el.style.opacity = '1';
        el.style.paddingTop = padTop;
        el.style.paddingBottom = padBot;
        el.style.marginTop = marTop;
        el.style.marginBottom = marBot;
        setTimeout(function () {
            el.style.transition = ''; el.style.maxHeight = ''; el.style.overflow = '';
            el.style.opacity = ''; el.style.paddingTop = ''; el.style.paddingBottom = '';
            el.style.marginTop = ''; el.style.marginBottom = '';
            JiTA.ui._fitVertical();
        }, 340);
    },

    // Shared list-row builder for both views. `target` = the key link's anchor target ('_self' for the
    // EBR->defect list so you navigate in place; '_blank' for the defect->report list so the defect page stays
    // put). `action(key)` returns the trailing control ($ Mark-dup on the EBR view, Attach on the report view).
    // The staleNote / stale-class bits fire only for stale-demoted defect matches (undefined on reports), and
    // data-jita-key (read by the report view's incremental attach/slide-in) is harmless on the EBR view.
    _row: function (r, target, action, opts) {
        var pct = (typeof r.pct === 'number') ? r.pct : 0;
        var meta = r.status || '';
        if (r.resolution) { meta += (meta ? ' · ' : '') + r.resolution; }
        if (r.staleNote) { meta += (meta ? ' · ' : '') + r.staleNote; }   // Feature A: explain the demotion
        var $li = $('<li></li>').attr('data-jita-key', r.key);
        if (r.stale) { $li.addClass('jita-sd-stale'); }                    // Feature A: grey out stale-closed matches
        // Feature C: hover preview - a styled card (built in _showTip) showing the summary, full description
        // (incl. reproduction steps) and status, so the triager can judge a match without navigating.
        $li.on('mouseenter', function () { JiTA.ui._showTip(r, this, meta); });
        $li.on('mouseleave', function () { JiTA.ui._hideTip(); });
        $('<a></a>').attr('href', '/browse/' + r.key).attr('target', target).text(r.key).appendTo($li);
        if (!(opts && opts.noScore)) { $('<span class="jita-sd-score"></span>').text(pct + '%').appendTo($li); }   // reporter-list rows have no relevance score
        action(r.key).appendTo($li);
        $('<div class="jita-sd-sum"></div>').text(r.summary || '').appendTo($li);
        if (meta) { $('<div class="jita-sd-meta"></div>').text(meta).appendTo($li); }
        var created = JiTA.util.fmtDate(r.created);
        if (created) { $('<div class="jita-sd-date"></div>').text('Created ' + created).appendTo($li); }
        return $li;
    },

    // EBR view row: link navigates in place, trailing control marks the open EBR a duplicate of this defect.
    _item: function (r) {
        return JiTA.ui._row(r, '_self', function (k) { return JiTA.ui._markDupButton(k); });
    },

    // EDR/EO/PLAT "matching bug reports" row: link opens in a new tab, trailing control attaches the report.
    _reportItem: function (r) {
        return JiTA.ui._row(r, '_blank', function (k) { return JiTA.ui._attachReportButton(k); });
    },

    // Read the open issue's text from the DOM (reusing the Translate selectors); fall back to a REST GET.
    getIssueText: function (key) {
        var title = $("h1[data-testid='issue.views.issue-base.foundation.summary.heading']").text() || '';
        // Grab the WHOLE rich-text description container (not just the first couple of paragraphs) so the
        // cleaner sees everything, then strip boilerplate. Same normalization as the stored side.
        var descText = $("div[data-component-selector='jira-issue-view-rich-text-inline-edit-view-container']").text() || '';
        if (descText.replace(/\s+/g, '').length > 0) {
            return Promise.resolve(JiTA.util.cleanForCompare(title, descText));
        }
        // DOM not ready / empty body - fall back to the REST API.
        return new Promise(function (resolve) {
            $.ajax({ url: JiTA.HOST + '/rest/api/2/issue/' + key + '?fields=summary,description', dataType: 'json' })
                .done(function (d) {
                    var f = d.fields || {};
                    resolve(JiTA.util.cleanForCompare(f.summary || title, JiTA.util.toPlainText(f.description)));
                })
                .fail(function () { resolve(JiTA.util.cleanForCompare(title, descText)); });
        });
    },

    // Fetch (and cache per key) the open bug report's creation date, used by the stale-match demotion to
    // compare against a candidate defect's fix date. Resolves to an ISO string, or null if unavailable.
    _createdCache: {},
    _getCreated: function (key) {
        if (Object.prototype.hasOwnProperty.call(JiTA.ui._createdCache, key)) {
            return Promise.resolve(JiTA.ui._createdCache[key]);
        }
        return new Promise(function (resolve) {
            $.ajax({ url: JiTA.HOST + '/rest/api/2/issue/' + key + '?fields=created', dataType: 'json' })
                .done(function (d) {
                    var created = (d && d.fields && d.fields.created) || null;
                    JiTA.ui._createdCache[key] = created;
                    resolve(created);
                })
                .fail(function () { JiTA.ui._createdCache[key] = null; resolve(null); });
        });
    },

    // Scan THIS bug report's attached log file(s) for known defect signatures, without the user opening the
    // log. Lists the issue's attachments, fetches each log*.txt as text, and runs the same stack-fingerprint
    // matching. Resolves to { defect -> { defect, count, msg } }, cached per key. Fetching attachment content
    // goes through Jira's media redirect, which may be CORS-blocked in some setups - any failure just yields
    // no hits (the section stays hidden), never an error.
    // Fetch an attachment's text. Prefer GM_xmlhttpRequest, which bypasses the CORS block a same-origin XHR
    // hits when Jira's attachment-content endpoint 30x-redirects to its media host. Falls back to $.ajax if
    // GM_xmlhttpRequest isn't granted. Always resolves to a string ('' on any failure) so a hung/blocked
    // fetch can never stall the scan.
    _fetchText: function (url) {
        return new Promise(function (resolve) {
            if (typeof GM_xmlhttpRequest === 'function') {
                try {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: url,
                        onload: function (resp) { resolve((resp && resp.responseText) || ''); },
                        onerror: function () { resolve(''); },
                        ontimeout: function () { resolve(''); }
                    });
                    return;
                } catch (e) { /* fall through to $.ajax */ }
            }
            $.ajax({ url: url, dataType: 'text' })
                .done(function (t) { resolve(t || ''); })
                .fail(function () { resolve(''); });
        });
    },

    _logScanCache: {},
    scanIssueLog: function (key) {
        if (Object.prototype.hasOwnProperty.call(JiTA.ui._logScanCache, key)) {
            return Promise.resolve(JiTA.ui._logScanCache[key]);
        }
        return new Promise(function (resolve) {
            $.ajax({ url: JiTA.HOST + '/rest/api/3/issue/' + key + '?fields=attachment', dataType: 'json' })
                .done(function (d) {
                    var atts = (d && d.fields && d.fields.attachment) || [];
                    var logs = [];
                    for (var i = 0; i < atts.length; i++) {
                        var fn = atts[i].filename || '';
                        if (/\.txt$/i.test(fn) && /log/i.test(fn) && atts[i].content) { logs.push(atts[i]); }
                    }
                    if (!logs.length) { JiTA.ui._logScanCache[key] = {}; resolve({}); return; }
                    console.log('[JiTA] log scan ' + key + ': ' + logs.length + ' log attachment(s)');
                    var merged = {}, pending = logs.length;
                    function mergeFound(found) {
                        Object.keys(found || {}).forEach(function (k) {
                            if (!merged[k]) { merged[k] = { defect: k, count: 0, msg: found[k].msg, loose: !!found[k].loose }; }
                            merged[k].count += found[k].count;
                            if (!found[k].loose) { merged[k].loose = false; }   // an exact hit upgrades it
                            if (!merged[k].msg && found[k].msg) { merged[k].msg = found[k].msg; }
                        });
                        if (--pending === 0) {
                            console.log('[JiTA] log scan ' + key + ': ' + Object.keys(merged).length + ' known defect(s) matched');
                            JiTA.ui._logScanCache[key] = merged;
                            resolve(merged);
                        }
                    }
                    logs.forEach(function (att) {
                        JiTA.ui._fetchText(att.content).then(function (txt) {
                            if (!txt) { mergeFound({}); return; }
                            JiTA.logsig.matchText(txt).then(mergeFound, function () { mergeFound({}); });
                        }, function () { mergeFound({}); });
                    });
                })
                .fail(function () { JiTA.ui._logScanCache[key] = {}; resolve({}); });
        });
    },

    // Populate the "Known defects in attached log" section of the panel (hidden unless there are hits). Each
    // entry links to the defect and reuses the same hover-preview card as the suggestions.
    renderLogLink: function (key) {
        var $box = $('#jita-sd-loglink');
        if (!$box.length) { return; }
        $box.removeClass('has-hits').empty();
        JiTA.db.countDefectsOnly().then(function (n) {
            if (!n) { return; }   // no defects to match the log against yet
            JiTA.ui.scanIssueLog(key).then(function (found) {
                if (JiTA.ui.currentKey !== key) { return; }   // navigated to another issue meanwhile
                var keys = Object.keys(found || {});
                keys = keys.filter(function (k) { return !JiTA.hidden.isHidden(k); });   // drop user-hidden defects from the list
                if (!keys.length) { return; }
                keys.sort(function (a, b) { return found[b].count - found[a].count || (a < b ? -1 : 1); });
                var $b = $('#jita-sd-loglink');
                $b.empty();
                $('<div class="jita-sd-loglink-head"></div>').text('⚠ Known defects in attached log (' + keys.length + ')').appendTo($b);
                var $ul = $('<ul></ul>').appendTo($b);
                keys.forEach(function (k) {
                    var $li = $('<li></li>');
                    $('<a></a>').attr('href', '/browse/' + k).attr('target', '_blank').text(k).appendTo($li);
                    if (found[k].loose) {   // matched only by crash site (same bug, different path)
                        $('<span class="jita-sd-loose"></span>').text('~ similar')
                            .attr('title', 'Same crash site, reached via a different call path - possibly related').appendTo($li);
                    }
                    JiTA.ui._markDupButton(k).appendTo($li);   // same one-click "Mark dup" as the suggestions
                    JiTA.ui._hideButton(k).appendTo($li);      // temporarily ignore this defect (also hides it from Similar defects)
                    $('<span class="count"></span>').text(found[k].count + '×').appendTo($li);
                    $li.on('mouseenter', function () { JiTA.logsig._showDefectTip(k, this); });
                    $li.on('mouseleave', function () { JiTA.logsig._hoverKey = null; if (JiTA.ui._hideTip) { JiTA.ui._hideTip(); } });
                    $ul.append($li);
                });
                $b.addClass('has-hits');
            });
        });
    },

    // Coalesce re-render requests. A single sync drives several "refresh the list" triggers in quick
    // succession - the sync's own completion, then embed.prepare()'s completion after the embed pass, and
    // (for autoSync) both the defect and EBR legs - and each render() empties + refills #jita-sd-list, so the
    // list visibly rebuilds several times. Route those background triggers through here so a burst collapses
    // into ONE render of whichever view is currently open. (User-initiated renders - navigation, panel-style
    // toggle - still call render()/renderReports() directly for instant feedback.)
    _renderTimer: null,
    scheduleRender: function () {
        if (!JiTA.ui.currentKey) { return; }
        if (JiTA.ui._renderTimer) { clearTimeout(JiTA.ui._renderTimer); }
        JiTA.ui._renderTimer = setTimeout(function () {
            JiTA.ui._renderTimer = null;
            var k = JiTA.ui.currentKey;
            if (!k) { return; }
            if (/^EBR-/.test(k)) { JiTA.ui.render(k); }
            else if (JiTA.ui._isReportsKey(k)) { JiTA.ui.renderReports(k); }
        }, 600);
    },

    render: function (key) {
        // View-mode switch: when the funnel's "this reporter's other reports" toggle is on, the EBR panel lists
        // the reporter's OTHER reports instead of similar defects. Every re-render path funnels through here, so
        // the branch lives here (one chokepoint) rather than at each caller.
        if (JiTA.ui.reporterMode) { return JiTA.ui.renderReporterReports(key); }
        JiTA.ui._ensurePanel();
        JiTA.ui._syncFilterBtn();   // reflect any active session filters on the funnel
        var terms = JiTA.ui._filterTerms();   // filter box: restrict the ranked corpus to these terms (whole DB)
        $('#jita-sd-title').text('Similar defects');   // reset title (the panel is shared with the EDR reports view)
        $('#jita-sd-exccluster').removeClass('has-hits').empty();   // defect-only section; clear it on the EBR view
        JiTA.ui.renderLogLink(key);   // scan the attached log for known defects (no need to open it)
        $('#jita-sd-list').empty();
        JiTA.ui.setStatus('Finding similar defects…');
        JiTA.ui.getIssueText(key).then(function (text) {
            return JiTA.db.countDefectsOnly().then(function (n) {
                if (!n) {
                    JiTA.ui.setStatus('No local data yet – open the Tampermonkey menu and click “Sync defects now”.');
                    return;
                }
                if (!text) { JiTA.ui.setStatus('Could not read this issue’s text.'); return; }
                return JiTA.ui._getCreated(key).then(function (brCreated) {
                return JiTA.rank.suggestBest(text, key, brCreated, JiTA.ui.modeOverride, terms).then(function (out) {
                    var results = out.results || [];
                    $('#jita-sd-mode').text(out.mode);   // 'Hybrid' or 'Keyword'
                    if (!results.length) { JiTA.ui.setStatus('No similar defects found (' + n + ' indexed).'); return; }
                    JiTA.ui.setStatus(results.length + ' suggestions · ' + out.mode + ' · ' + n + ' indexed');
                    // Feature C: enrich the displayed results with each defect's full description (which
                    // includes the reproduction steps) for the hover tooltip. Only a handful of indexed-DB
                    // reads (just the shown results), so it's cheap.
                    return Promise.all(results.map(function (r) {
                        return JiTA.db.getDefect(r.key).then(function (rec) {
                            if (rec) { r.description = rec.description; r.created = rec.created; }
                            return r;
                        }, function () { return r; });
                    })).then(function () {
                        var $list = $('#jita-sd-list');
                        $list.empty();   // clear atomically right before filling: a concurrent re-render (e.g. after an auto-sync) also emptied at its top, but both appended later - emptying here keeps each render self-contained and avoids doubled rows
                        for (var i = 0; i < results.length; i++) { $list.append(JiTA.ui._item(results[i])); }
                        JiTA.ui._fitVertical();   // list height changed - re-check it still fits / drops up
                    });
                });
                });
            });
        }).catch(function (e) { JiTA.ui.setStatus('Error: ' + (e && e.message || e)); });
    },

    // EDR (defect) view: rank the OPEN bug reports that best match this defect's description (keyword BM25),
    // and list them in the same panel. Mirrors render() but over the EBR index, with no log-scan / mark-dup.
    renderReports: function (key) {
        JiTA.ui._ensurePanel();
        JiTA.ui._syncFilterBtn();   // reflect any active session filters on the funnel
        var terms = JiTA.ui._filterTerms();   // filter box: restrict the ranked corpus to these terms (whole DB)
        $('#jita-sd-title').text('Matching bug reports');
        $('#jita-sd-loglink').removeClass('has-hits').empty();   // EBR-only section; unused on a defect
        $('#jita-sd-list').empty();
        JiTA.ui.renderExceptionCluster(key);   // list other defects that reported the same exception
        JiTA.ui.setStatus('Finding matching bug reports…');
        JiTA.ui.getIssueText(key).then(function (text) {
            return JiTA.db.countEbr().then(function (n) {
                if (!n) {
                    JiTA.ui.setStatus('No bug reports synced yet – open the Tampermonkey menu and click “Sync bug reports now”.');
                    return;
                }
                if (!text) { JiTA.ui.setStatus('Could not read this defect’s text.'); return; }
                return JiTA.rank.suggestEbrBest(text, key, JiTA.ui.modeOverride, terms).then(function (out) {
                    var results = out.results || [];
                    $('#jita-sd-mode').text(out.mode);   // 'Hybrid' or 'Keyword'
                    if (!results.length) { JiTA.ui.setStatus('No matching bug reports found (' + n + ' open).'); return; }
                    JiTA.ui.setStatus(results.length + ' matches · ' + out.mode + ' · ' + n + ' open reports');
                    // Enrich with each report's full description for the hover preview (a handful of reads).
                    return Promise.all(results.map(function (r) {
                        return JiTA.db.getDefect(r.key).then(function (rec) {
                            if (rec) { r.description = rec.description; r.created = rec.created; }
                            return r;
                        }, function () { return r; });
                    })).then(function () {
                        var $list = $('#jita-sd-list');
                        $list.empty();   // clear atomically right before filling (see render() - avoids doubled rows from a concurrent re-render)
                        for (var i = 0; i < results.length; i++) { $list.append(JiTA.ui._reportItem(results[i])); }
                        JiTA.ui._fitVertical();   // list height changed - re-check it still fits / drops up
                    });
                });
            });
        }).catch(function (e) { JiTA.ui.setStatus('Error: ' + (e && e.message || e)); });
    },

    // EBR view, "reporter's other reports" mode (funnel toggle): list EVERY other bug report from the same
    // Original Reporter as this one, newest first. This is a LIVE Jira search (not the local cache) on purpose:
    // we deliberately want ALL of the reporter's reports - open AND closed, GM-team included - and the cache
    // holds only open, non-GM reports. Closed reports are greyed so the open ones stand out.
    renderReporterReports: function (key) {
        JiTA.ui._ensurePanel();
        JiTA.ui._syncFilterBtn();
        $('#jita-sd-title').text('Reports by this reporter');
        $('#jita-sd-mode').text('');                                  // no ranking mode in this view
        $('#jita-sd-exccluster').removeClass('has-hits').empty();     // defect-only section
        $('#jita-sd-loglink').removeClass('has-hits').empty();        // similar-defects-only section
        $('#jita-sd-list').empty();
        JiTA.ui.setStatus('Finding this reporter’s other reports…');
        JiTA.ui._getReporterId(key).then(function (rid) {
            if (JiTA.ui.currentKey !== key || !JiTA.ui.reporterMode) { return; }   // navigated / toggled off meanwhile
            if (!rid) { JiTA.ui.setStatus('This report has no Original Reporter ID.'); return; }
            var jql = 'project = EBR AND cf[11660] ~ ' + JiTA.ui._jqlQuote(rid) + ' ORDER BY created DESC';
            return JiTA.sync._apiPost('/rest/api/3/search/jql', {
                jql: jql, fields: ['summary', 'status', 'resolution', 'created', 'description'], maxResults: 100
            }).then(function (r) {
                if (JiTA.ui.currentKey !== key || !JiTA.ui.reporterMode) { return; }
                var issues = (r.data && r.data.issues) || [];
                var rows = [];
                for (var i = 0; i < issues.length; i++) {
                    var iss = issues[i], f = iss.fields || {};
                    if (iss.key === key) { continue; }   // exclude the report we're on
                    var status = (f.status && f.status.name) || '';
                    rows.push({
                        key: iss.key,
                        summary: f.summary || '',
                        status: status,
                        resolution: (f.resolution && f.resolution.name) || null,
                        created: f.created || null,
                        description: JiTA.util.toPlainText(f.description),
                        stale: JiTA.util.isClosedStatus(status)   // grey out closed reports so the open ones stand out
                    });
                }
                if (!rows.length) { JiTA.ui.setStatus('No other reports from this reporter.'); return; }
                JiTA.ui.setStatus(rows.length + ' other report' + (rows.length === 1 ? '' : 's') + ' from this reporter');
                var $list = $('#jita-sd-list');
                $list.empty();
                for (var j = 0; j < rows.length; j++) { $list.append(JiTA.ui._reporterRow(rows[j])); }
                JiTA.ui._fitVertical();
            });
        }).catch(function (e) { JiTA.ui.setStatus('Error: ' + (e && e.message || e)); });
    },

    // Wrap a value as a JQL string literal (escape backslashes + double-quotes).
    _jqlQuote: function (s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; },

    // This report's Original Reporter ID, read live from Jira (one field). '' when the field is empty/absent.
    _getReporterId: function (key) {
        return new Promise(function (resolve) {
            $.ajax({ url: JiTA.HOST + '/rest/api/2/issue/' + key + '?fields=customfield_11660', dataType: 'json' })
                .done(function (d) { var v = d && d.fields && d.fields.customfield_11660; resolve(typeof v === 'string' ? v.trim() : ''); })
                .fail(function () { resolve(''); });
        });
    },

    // Reporter-list row: link navigates in place; no relevance score and no trailing control (not a ranked match).
    _reporterRow: function (r) {
        return JiTA.ui._row(r, '_self', function () { return $(); }, { noScore: true });
    },

    // Populate the "Same exception" section: every OTHER defect that reported the same exception signature as
    // this one, each with its status (Open / Fixed). A sibling that is already FIXED while this defect is still
    // open is flagged "⚠ regression?". Hidden unless there are siblings. Reuses the shared cluster member rows.
    renderExceptionCluster: function (key) {
        var $box = $('#jita-sd-exccluster');
        if (!$box.length) { return; }
        $box.removeClass('has-hits').empty();
        // Exact stack siblings ("Same exception") AND looser crash-site peers ("Possibly related").
        Promise.all([JiTA.logsig.siblingsForKey(key), JiTA.logsig.relatedForKey(key)]).then(function (res) {
            if (JiTA.ui.currentKey !== key) { return; }       // navigated to another issue meanwhile
            var siblings = res[0] || [], related = res[1] || [];
            if (!siblings.length && !related.length) { return; }
            return JiTA.db.getDefect(key).then(function (rec) {
                if (JiTA.ui.currentKey !== key) { return; }
                var currentResolved = !!(rec && (rec.resolution || rec.resolutiondate));
                JiTA.logsig._injectClusterCss();
                var $b = $('#jita-sd-exccluster');
                $b.empty();
                // ⚠ regression flag: a peer that's already FIXED while this defect is still open.
                function regressionWarn(m) {
                    if (!((m.resolution || m.resolutiondate) && !currentResolved)) { return null; }
                    var warn = document.createElement('span');
                    warn.className = 'jita-exc-badge warn';
                    warn.textContent = '⚠ regression?';
                    warn.title = 'This exception was already resolved in ' + m.key + ', but the current issue is still open – possible regression.';
                    return warn;
                }
                function section(headText, headTitle, list, marginTop) {
                    var $h = $('<div class="jita-sd-exccluster-head"></div>').text(headText);
                    if (headTitle) { $h.attr('title', headTitle); }
                    if (marginTop) { $h.css('margin-top', '8px'); }
                    $h.appendTo($b);
                    var box = document.createElement('div');
                    box.className = 'jita-exc-members';
                    list.forEach(function (m) { box.appendChild(JiTA.logsig._memberRowEl(m, regressionWarn(m))); });
                    $b.append(box);
                }
                if (siblings.length) { section('Same exception (' + siblings.length + ')', '', siblings, false); }
                if (related.length) { section('Possibly related (' + related.length + ')', 'Same crash site, reached via a different call path', related, siblings.length > 0); }
                $b.addClass('has-hits');
                JiTA.ui._fitVertical();
            });
        }).catch(function () { /* swallow - the section just stays hidden */ });
    },

    // When we land on an EDR that isn't in the local DB yet (e.g. a freshly created / just-converted defect),
    // kick off a quiet catch-up sync so it gets indexed. Guarded per key (once per session) and skipped while
    // a sync is already running or when the defect DB is empty (an empty DB is handled by the scheduler's
    // auto-initial build instead). The catch-up is incremental, so it cheaply fetches the new EDR.
    _autoSyncedKeys: {},
    _maybeSyncForDefect: function (key) {
        if (JiTA.ui._autoSyncedKeys[key]) { return; }
        if (JiTA.sync.running) { return; }
        JiTA.db.countDefectsOnly().then(function (n) {
            if (!n) { return; }   // empty defect DB - the scheduler's auto-initial build covers this
            return JiTA.db.getDefect(key).then(function (rec) {
                if (rec) { return; }   // already indexed - nothing to do
                JiTA.ui._autoSyncedKeys[key] = true;   // don't retrigger for this key this session
                console.log('[JiTA] ' + key + ' not in local DB - triggering catch-up sync');
                JiTA.sync.autoSync();   // quiet incremental catch-up (fetches the new defect/EO issue; embeds + refreshes)
            });
        });
    },

    // Keys that are in the synced DEFECT scope (JiTA.SCOPE = "project in (EDR, EO, PLAT)"), so the local DB
    // holds + embeds them and they surface as candidates in the EBR "similar defects" view. Gates the
    // defect-side catch-up sync (_maybeSyncForDefect), which only makes sense for issues we actually crawl.
    _isDefectKey: function (key) { return /^(EDR|EO|PLAT)-/.test(key || ''); },

    // Keys that get the "Matching bug reports" (reverse) view. Same set as _isDefectKey now that PLAT is
    // crawled - kept as a distinct predicate to document the "shows the reverse view" intent (vs. "is in the
    // crawled scope").
    _isReportsKey: function (key) { return /^(EDR|EO|PLAT)-/.test(key || ''); },

    // Show/refresh the panel on EBR bug reports (similar defects) AND on EDR/EO/PLAT issues (matching
    // reports); re-query when the issue key changes. Any other issue type removes the panel.
    ensure: function () {
        if (!savedVariables[5][1]) { return; }
        var $bc = $(issueItem);
        if (!$bc.length) { return; }
        var key = $.trim($bc.first().text());
        var isEbr = /^EBR-/.test(key), isReports = JiTA.ui._isReportsKey(key);
        if (!isEbr && !isReports) {
            // neither a bug report nor a defect/EO/PLAT issue - remove any stale panel (either style)
            if ($('#jita-sd-panel').length) { $('#jita-sd-panel').remove(); }
            if ($('#jita-side-group').length) { $('#jita-side-group').remove(); }
            JiTA.ui.currentKey = null;
            return;
        }
        // Skip only when the chrome is mounted AND it's the same issue. In sidebar mode a Jira re-render can
        // wipe our injected section; _chromePresent() then reports false and we re-mount + repopulate here.
        if (JiTA.ui._chromePresent() && JiTA.ui.currentKey === key) { return; }
        if (JiTA.ui.currentKey !== key) { JiTA.ui.reporterMode = false; }   // new issue -> leave the reporter-reports view (its reporter is per-issue)
        JiTA.ui.currentKey = key;
        if (isEbr) {
            JiTA.ui.render(key);              // bug report -> similar defects
        } else {
            JiTA.ui.renderReports(key);       // defect / EO / PLAT issue -> matching open bug reports
            // Only EDR/EO are in the crawled scope, so only they get the "index this issue if missing" catch-up.
            if (JiTA.ui._isDefectKey(key)) { JiTA.ui._maybeSyncForDefect(key); }
        }
    }
};


/* ---- consolidated in-page settings menu ---- */
// One Tampermonkey command ("⚙ Jira Triage Assistant - Settings…") opens this modal overlay, which replaces the
// long flat list of GM menu commands. It groups the feature on/off switches and, when the Triage Assistant
// is enabled, its actions (sync defects / sync bug reports / rebuild) + the embedding-backend switch +
// a live count of what's indexed. The existing toggle* functions still do the actual work; they call
// refreshMenu() which re-renders this overlay so it reflects the new state without closing.
JiTA.menu = {
    _cssInjected: false,
    css: '\
#jita-menu-overlay { position: fixed; inset: 0; z-index: 10000; background: rgba(0,0,0,.5); display: flex;\
  align-items: center; justify-content: center; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; }\
#jita-menu { width: 360px; max-height: 82vh; overflow-y: auto; background: #1D2125; color: #e6e6e6;\
  border: 1px solid #3a434d; border-radius: 8px; box-shadow: 0 8px 30px rgba(0,0,0,.55); font-size: 13px; }\
#jita-menu .jita-menu-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; background: #282d33; border-radius: 8px 8px 0 0; position: sticky; top: 0; }\
#jita-menu .jita-menu-head h2 { margin: 0; font-size: 14px; font-weight: 700; flex: 1; }\
#jita-menu .jita-menu-x { cursor: pointer; font-weight: 700; font-size: 18px; line-height: 1; padding: 0 4px; color: #9aa6b2; }\
#jita-menu .jita-menu-x:hover { color: #fff; }\
#jita-menu .jita-menu-sect { padding: 4px 14px 12px; }\
#jita-menu .jita-menu-sect h3 { margin: 12px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #7a8694; }\
#jita-menu .jita-menu-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid #2c333a; }\
#jita-menu .jita-menu-row:last-child { border-bottom: none; }\
#jita-menu .jita-menu-row .lbl { flex: 1; }\
#jita-menu .jita-menu-row .sub { display: block; color: #7a8694; font-size: 11px; margin-top: 2px; }\
#jita-menu .jita-sw { width: 38px; height: 20px; border-radius: 12px; background: #3a434d; position: relative; cursor: pointer; flex: 0 0 auto; transition: background .15s; }\
#jita-menu .jita-sw.on { background: #4caf7d; }\
#jita-menu .jita-sw .knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: left .15s; }\
#jita-menu .jita-sw.on .knob { left: 20px; }\
#jita-menu .jita-menu-actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 6px 0 2px; }\
#jita-menu .jita-btn { background: #2c333a; color: #e6e6e6; border: 1px solid #3a434d; border-radius: 5px; padding: 6px 10px; cursor: pointer; font-size: 12px; }\
#jita-menu .jita-btn:hover { background: #343c44; border-color: #4c9aff; }\
#jita-menu .jita-btn:disabled { opacity: .5; cursor: default; }\
#jita-menu .jita-btn:disabled:hover { background: #2c333a; border-color: #3a434d; }\
#jita-menu .jita-num { width: 56px; flex: 0 0 auto; background: #2c333a; color: #e6e6e6; border: 1px solid #3a434d; border-radius: 5px; padding: 5px 8px; font-size: 12px; text-align: center; }\
#jita-menu .jita-num:focus { outline: none; border-color: #4c9aff; }\
#jita-menu .jita-menu-status { color: #9aa6b2; font-size: 11px; padding: 8px 0 0; }\
#jita-menu .jita-resp-list { display: flex; flex-direction: column; gap: 8px; padding: 6px 0; }\
#jita-menu .jita-resp-item { display: flex; flex-direction: column; gap: 4px; border: 1px solid #2c333a; border-radius: 6px; padding: 8px; position: relative; }\
#jita-menu .jita-resp-title { background: #14181b; color: #e6e6e6; border: 1px solid #3a434d; border-radius: 4px; padding: 5px 26px 5px 8px; font-size: 12px; font-weight: 600; }\
#jita-menu .jita-resp-body { background: #14181b; color: #e6e6e6; border: 1px solid #3a434d; border-radius: 4px; padding: 5px 8px; font-size: 12px; resize: vertical; font-family: inherit; line-height: 1.4; }\
#jita-menu .jita-resp-title:focus, #jita-menu .jita-resp-body:focus { outline: none; border-color: #4c9aff; }\
#jita-menu .jita-resp-del { position: absolute; top: 6px; right: 6px; width: 20px; height: 20px; line-height: 1; background: transparent; color: #9aa6b2; border: none; border-radius: 4px; cursor: pointer; font-size: 16px; }\
#jita-menu .jita-resp-del:hover { background: #3a434d; color: #fff; }',

    _injectCss: function () {
        if (!JiTA.menu._cssInjected) { GM_addStyle(JiTA.menu.css); JiTA.menu._cssInjected = true; }
    },

    isOpen: function () { return !!document.getElementById('jita-menu-overlay'); },

    close: function () {
        var o = document.getElementById('jita-menu-overlay');
        if (o && o.parentNode) { o.parentNode.removeChild(o); }
        if (JiTA.menu._esc) { document.removeEventListener('keydown', JiTA.menu._esc); JiTA.menu._esc = null; }
    },

    // Build the shared modal overlay chrome (#jita-menu-overlay backdrop + #jita-menu box) used by the settings
    // menu, the Exception-clusters view, and the responses editor. Closes any existing overlay first - tearing
    // down its Esc listener, which fixes a leak: the settings command's close() only removed _esc, so the
    // clusters/editor Esc handlers (their own closures) previously lingered until the next Escape. Injects the
    // menu CSS, wires backdrop + Esc to menu.close (the single close path, always tracked via _esc), and, when
    // opts.title is given, builds .jita-menu-head with an <h2> + × button. opts.wide adds .jita-menu-wide (editor).
    // Returns { $overlay, $menu, close }. The settings menu passes NO title - render() rebuilds its head on
    // every refresh (it $p.empty()s first).
    _openOverlay: function (opts) {
        opts = opts || {};
        JiTA.menu.close();
        JiTA.menu._injectCss();
        var $overlay = $('<div id="jita-menu-overlay"></div>');
        $overlay.on('click', function (e) { if (e.target === this) { JiTA.menu.close(); } });   // backdrop click
        var $menu = $('<div id="jita-menu"' + (opts.wide ? ' class="jita-menu-wide"' : '') + '></div>').appendTo($overlay);
        if (opts.title) {
            var $head = $('<div class="jita-menu-head"><h2></h2></div>');
            $head.children('h2').text(opts.title);
            $('<span class="jita-menu-x" title="Close (Esc)">×</span>').on('click', JiTA.menu.close).appendTo($head);
            $menu.append($head);
        }
        $overlay.appendTo(document.body);
        JiTA.menu._esc = function (e) { if (e.key === 'Escape') { JiTA.menu.close(); } };
        document.addEventListener('keydown', JiTA.menu._esc);
        return { $overlay: $overlay, $menu: $menu, close: JiTA.menu.close };
    },

    // Open (toggle): a second click of the menu command closes it again.
    open: function () {
        if (JiTA.menu.isOpen()) { JiTA.menu.close(); return; }
        JiTA.menu._openOverlay({});   // no title - render() builds the head on every refresh
        JiTA.menu.render();
    },

    // A label + on/off switch row for the feature at savedVariables[index]. Clicking flips it via
    // toggleFeature(index) (which persists it + re-renders this overlay so the switch updates itself); an
    // optional onAfter runs afterwards for features that need extra work on change (e.g. the Triage Assistant
    // mounting / tearing down its panel).
    _toggleRow: function (label, index, onAfter) {
        var $row = $('<div class="jita-menu-row"></div>');
        $('<span class="lbl"></span>').text(label).appendTo($row);
        var $sw = $('<div class="jita-sw"><span class="knob"></span></div>');
        if (savedVariables[index][1]) { $sw.addClass('on'); }
        $sw.on('click', function () {
            toggleFeature(index);
            if (onAfter) { try { onAfter(); } catch (e) { /* swallow */ } }
        });
        $row.append($sw);
        return $row;
    },

    render: function () {
        var $p = $('#jita-menu');
        if (!$p.length) { return; }
        $p.empty();

        var $head = $('<div class="jita-menu-head"><h2>Jira Triage Assistant</h2></div>');
        $('<span class="jita-menu-x" title="Close (Esc)">×</span>').on('click', JiTA.menu.close).appendTo($head);
        $p.append($head);

        // ---- Features ----
        var $feat = $('<div class="jita-menu-sect"></div>');
        $('<h3>Features</h3>').appendTo($feat);
        $feat.append(JiTA.menu._toggleRow('Log Parser', 1));
        $feat.append(JiTA.menu._toggleRow('Custom Scrollbar', 2));
        $feat.append(JiTA.menu._toggleRow('Extra Buttons', 4));
        // Triage Assistant needs extra work on change: mount its panel when enabled, tear it down when disabled.
        $feat.append(JiTA.menu._toggleRow('Triage Assistant', 5, function () {
            if (!savedVariables[5][1]) {
                $('#jita-sd-panel').remove();
                $('#jita-side-group').remove();
                if (typeof JiTA !== 'undefined') { JiTA.ui.currentKey = null; }
            } else if (typeof JiTA !== 'undefined') {
                JiTA.ui.ensure();
            }
        }));
        $p.append($feat);

        // ---- Canned responses (Zendesk Support panel) ----
        // A repository of reusable replies, shown as a dropdown in the Zendesk Support activity panel (picking
        // one replaces the editor). The actual editing happens in a roomier standalone window
        // (JiTA.responses.openEditor); here we just expose the entry point + a quick "Restore defaults".
        // Edits persist in GM storage and reach the Forge-iframe dropdown live.
        var $resp = $('<div class="jita-menu-sect"></div>');
        $('<h3>Canned responses</h3>').appendTo($resp);
        $('<div class="jita-menu-status">Shown as a dropdown in the Zendesk Support panel; picking one replaces the comment editor.</div>').appendTo($resp);
        var $respActions = $('<div class="jita-menu-actions"></div>').appendTo($resp);
        $('<button class="jita-btn">Customize responses</button>')
            .on('click', function () { JiTA.responses.openEditor(); }).appendTo($respActions);
        $p.append($resp);

        // ---- Triage Assistant (only when enabled) ----
        if (savedVariables[5][1]) {
            var $ta = $('<div class="jita-menu-sect"></div>');
            $('<h3>Triage Assistant</h3>').appendTo($ta);

            var $actions = $('<div class="jita-menu-actions"></div>');
            $('<button class="jita-btn">Sync now</button>')
                .on('click', function () { JiTA.menu.close(); JiTA.sync.syncAllNow(); }).appendTo($actions);
            $('<button class="jita-btn">Rebuild defect DB</button>')
                .on('click', function () { JiTA.menu.close(); JiTA.sync.rebuild(); }).appendTo($actions);
            $('<button class="jita-btn">Rebuild BR DB</button>')
                .on('click', function () { JiTA.menu.close(); JiTA.sync.rebuildEbr(); }).appendTo($actions);
            $('<button class="jita-btn">Exception clusters</button>')
                .on('click', function () { JiTA.logsig.openClustersView(); }).appendTo($actions);
            $ta.append($actions);

            // Panel style (integrated sidebar vs floating box). JiTA.ui.toggleStyle() re-mounts in place.
            var sidebarOn = (typeof JiTA !== 'undefined' && JiTA.ui.mode() === 'sidebar');
            var $styleRow = $('<div class="jita-menu-row"></div>');
            $('<span class="lbl">Panel style</span>')
                .append($('<span class="sub"></span>').text('Currently: ' + (sidebarOn ? 'Sidebar (integrated)' : 'Floating (draggable box)')))
                .appendTo($styleRow);
            $('<button class="jita-btn"></button>').text(sidebarOn ? 'Switch to floating' : 'Switch to sidebar')
                .on('click', function () { JiTA.menu.close(); JiTA.ui.toggleStyle(); }).appendTo($styleRow);
            $ta.append($styleRow);

            // Results shown: how many related issues the panel lists (JiTA.TOP_N). Persisted in 'sdTopN';
            // committing a new value updates JiTA.TOP_N live and re-renders the open view (no reload). The
            // ranking reads TOP_N at query time and CAND (50) bounds the candidate pool, so 1..30 is safe.
            var $cntRow = $('<div class="jita-menu-row"></div>');
            $('<span class="lbl">Results shown</span>')
                .append($('<span class="sub"></span>').text('How many related issues to list (1–30)'))
                .appendTo($cntRow);
            var $cnt = $('<input type="number" min="1" max="30" class="jita-num">').val(JiTA.TOP_N);
            function commitTopN() {
                var v = parseInt($cnt.val(), 10);
                if (isNaN(v)) { v = JiTA.TOP_N; }
                v = Math.max(1, Math.min(30, v));
                $cnt.val(v);
                if (v === JiTA.TOP_N) { return; }
                JiTA.TOP_N = v;
                gmSet('sdTopN', v);
                // Re-render whichever view is open so the new count takes effect immediately.
                var k = JiTA.ui.currentKey;
                if (k && /^EBR-/.test(k)) { JiTA.ui.render(k); }
                else if (k && JiTA.ui._isReportsKey(k)) { JiTA.ui.renderReports(k); }
            }
            $cnt.on('change', commitTopN);
            $cnt.on('keydown', function (e) { if (e.key === 'Enter') { commitTopN(); } });
            $cntRow.append($cnt);
            $ta.append($cntRow);

            // Embedding backend (GPU vs CPU). Same flags toggleEmbedBackend() reads/writes; it reloads.
            var gpuOn = gmGet('sdTryWebgpu', true) && !gmGet('sdForceCpu', false);
            var $row = $('<div class="jita-menu-row"></div>');
            $('<span class="lbl">Embedding backend</span>')
                .append($('<span class="sub"></span>').text('Currently: ' + (gpuOn ? 'GPU (faster, experimental)' : 'CPU (stable)')))
                .appendTo($row);
            $('<button class="jita-btn"></button>').text(gpuOn ? 'Switch to CPU' : 'Switch to GPU')
                .on('click', function () { toggleEmbedBackend(); }).appendTo($row);
            $ta.append($row);

            // Hidden suggestions: user-dismissed issues (persisted in GM, survive script updates). Show the
            // active count and let the user clear them all at once - each also auto-expires after its window.
            var hiddenN = JiTA.hidden.count();
            var $hidRow = $('<div class="jita-menu-row"></div>');
            $('<span class="lbl">Hidden suggestions</span>')
                .append($('<span class="sub"></span>').text(hiddenN ? (hiddenN + ' currently hidden (auto-expire)') : 'None hidden'))
                .appendTo($hidRow);
            var $clrHidden = $('<button class="jita-btn"></button>').text('Unhide all')
                .on('click', function () {
                    JiTA.hidden.clear();
                    var k = JiTA.ui.currentKey;
                    if (k && /^EBR-/.test(k)) { JiTA.ui.render(k); }
                    else if (k && JiTA.ui._isReportsKey(k)) { JiTA.ui.renderReports(k); }
                    refreshMenu();
                });
            if (!hiddenN) { $clrHidden.prop('disabled', true); }
            $hidRow.append($clrHidden);
            $ta.append($hidRow);

            // Live "what's indexed" status (defects + open reports) + when each local DB was last built,
            // filled in async.
            var $status = $('<div class="jita-menu-status">Loading database status…</div>').appendTo($ta);
            JiTA.db.countDefectsOnly().then(function (d) {
                return JiTA.db.countEbr().then(function (e) {
                    return JiTA.db.getMeta('dbBuiltAtDefects').then(function (bd) {
                        return JiTA.db.getMeta('dbBuiltAtEbr').then(function (be) {
                            if (!document.getElementById('jita-menu')) { return; }
                            var line = d + ' defects · ' + e + ' open bug reports indexed locally';
                            var built = [];
                            if (bd) { built.push('defects ' + JiTA.util.fmtDate(bd)); }
                            if (be) { built.push('reports ' + JiTA.util.fmtDate(be)); }
                            if (built.length) { line += ' · built ' + built.join(' / '); }
                            $status.text(line);
                        });
                    });
                });
            }, function () { $status.text(''); });

            $p.append($ta);
        }
    }
};


/* ---- one-time migration: make WebGPU the default backend ---- */
// Earlier builds defaulted to CPU and could leave a sticky `sdForceCpu` lock set from debugging / a past
// device loss. This build makes WebGPU the default, so clear that stale lock ONCE (and arm `sdTryWebgpu`) to
// give GPU a fresh attempt. Any future device loss re-sets the lock as normal, so the crash-loop guard still
// works and the menu toggle can still force CPU.
(function () {
    if (typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function') { return; }
    if (!GM_getValue('sdGpuDefault_v1', false)) {
        GM_setValue('sdForceCpu', false);
        GM_setValue('sdTryWebgpu', true);
        GM_setValue('sdGpuDefault_v1', true);
    }
})();


/* ---- data-schema migration: auto-rebuild a local DB that predates a stored-field change ---- */
// The stored records evolve over time. Most changes are picked up by the normal incremental catch-up, but a
// few (a brand-new FIELD, like `created`) cannot be: incremental only re-fetches issues whose `updated` moved,
// so every pre-existing row keeps the old shape forever. To handle that, each dataset is stamped with
// JiTA.DATA_VERSION whenever it is built from scratch (fullSync / fullSyncEbr - which a manual rebuild also
// routes through). On load, if a POPULATED dataset is stamped BELOW the current DATA_VERSION - or carries no
// stamp at all, i.e. it was built before this mechanism shipped - we transparently re-fetch just that dataset
// once (refetchDefects / refetchEbr), which backfills the new field without dropping embeddings. Brand-new /
// empty DBs need nothing: their first full build stamps the current version.
JiTA.migrate = {
    _done: false,
    run: function () {
        if (JiTA.migrate._done) { return; }            // once per session
        JiTA.migrate._done = true;
        if (!savedVariables[5][1]) { return; }            // Triage Assistant off -> nothing to migrate
        JiTA.db.countDefectsOnly().then(function (nDef) {
            return JiTA.db.getMeta('dataVersionDefects').then(function (dv) {
                var defStale = nDef > 0 && (Number(dv) || 0) < JiTA.DATA_VERSION;
                return JiTA.db.countEbr().then(function (nEbr) {
                    return JiTA.db.getMeta('dataVersionEbr').then(function (ev) {
                        var ebrStale = nEbr > 0 && (Number(ev) || 0) < JiTA.DATA_VERSION;
                        if (!defStale && !ebrStale) { return; }
                        console.log('[JiTA] local DB schema out of date (defects v' + (Number(dv) || 0) +
                            ', reports v' + (Number(ev) || 0) + ' < v' + JiTA.DATA_VERSION +
                            ') - auto re-fetching to backfill new fields');
                        // Sequential: each refetch is single-flight (the `running` guard), so chain them.
                        var chain = Promise.resolve();
                        if (defStale) { chain = chain.then(function () { return JiTA.sync.refetchDefects(); }); }
                        if (ebrStale) { chain = chain.then(function () { return JiTA.sync.refetchEbr(); }); }
                        return chain;
                    });
                });
            });
        }).catch(function (e) { console.log('[JiTA] migration check skipped:', e && e.message || e); });
    }
};


/* ---- background auto-sync scheduler (Phase 3) ---- */
// Keeps the local DB fresh without the user clicking "Sync defects now": auto-initializes both datasets on
// first run and then runs incremental catch-ups roughly every INTERVAL_MS. A best-effort cross-tab lease
// (GM storage) keeps multiple open Jira tabs from all syncing at once; the in-tab `running` flag prevents
// overlap within a tab. We POLL on a short timer (POLL_MS) and let the persisted recentlySynced() gate
// decide when INTERVAL_MS has actually elapsed - polling far more often than the gate avoids the phase
// collision you'd get if the timer period equalled the gate window (which skipped every other run).
JiTA.sched = {
    INTERVAL_MS: 30 * 60 * 1000,   // minimum gap between catch-up syncs (the "freshness window")
    POLL_MS: 0.5 * 60 * 1000,      // how often we CHECK whether INTERVAL_MS has elapsed (≪ INTERVAL_MS)
    STARTUP_DELAY_MS: 20 * 1000,   // wait a bit after load so we don't compete with first paint / initial render
    LEASE_TTL_MS: 5 * 60 * 1000,   // a lease older than this is treated as abandoned (tab closed mid-sync)
    LEASE_KEY: 'sdSyncLease',
    LAST_SYNC_KEY: 'sdLastSyncTs',  // epoch ms of the last completed sync (any kind), persisted + shared across tabs
    tabId: 'tab-' + Math.floor(Math.random() * 1e9) + '-' + Date.now(),
    _timer: null,

    // True when a sync (auto / manual / rebuild) completed less than INTERVAL_MS ago. Used to gate the
    // startup tick so a page RELOAD shortly after a recent sync does not re-fetch (and re-render the Similar
    // Defects list) all over again - the user only wants a catch-up roughly every 30 minutes.
    recentlySynced: function () {
        var last = gmGet(JiTA.sched.LAST_SYNC_KEY, 0) || 0;
        return !!last && (Date.now() - last) < JiTA.sched.INTERVAL_MS;
    },

    // Stamp "a sync just completed" so recentlySynced() starts the 30-minute clock. Called from every sync
    // completion path (autoSync / syncNow / rebuild).
    markSynced: function () {
        gmSet(JiTA.sched.LAST_SYNC_KEY, Date.now());
        // If a log is open, re-match it against the freshly-synced defect index so a newly-indexed defect
        // (e.g. one you just created) appears in the "Defects in log" panel without reopening the log.
        try { if (JiTA.logsig) { JiTA.logsig.rematch(); } } catch (e2) { /* ignore */ }
    },

    // Best-effort single-syncer lease across tabs. Returns true if this tab may sync now. Not perfectly
    // race-free, but a rare double-run is harmless (bulkPut is idempotent and embeddings are preserved).
    _acquireLease: function () {
        var l = gmGet(JiTA.sched.LEASE_KEY, null);
        var now = Date.now();
        if (!l || !l.ts || (now - l.ts) > JiTA.sched.LEASE_TTL_MS || l.tabId === JiTA.sched.tabId) {
            gmSet(JiTA.sched.LEASE_KEY, { tabId: JiTA.sched.tabId, ts: now });
            return true;
        }
        return false;
    },

    tick: function () {
        if (!savedVariables[5][1]) { return; }            // feature disabled
        if (JiTA.sched.recentlySynced()) { return; }    // a sync ran < INTERVAL_MS ago (persisted) - don't re-fetch on reload
        if (!JiTA.sched._acquireLease()) { return; }    // another tab is the syncer right now
        JiTA.sync.autoSync();
    },

    start: function () {
        if (JiTA.sched._timer) { return; }
        setTimeout(function () {
            try { JiTA.sched.tick(); } catch (e) { /* swallow */ }
            // Poll every POLL_MS (≪ INTERVAL_MS). tick() itself only acts once recentlySynced() reports that
            // INTERVAL_MS has elapsed, so this reliably fires ~every 30 min instead of skipping windows.
            JiTA.sched._timer = setInterval(function () {
                try { JiTA.sched.tick(); } catch (e) { /* swallow */ }
            }, JiTA.sched.POLL_MS);
        }, JiTA.sched.STARTUP_DELAY_MS);
    }
};


/* ---- init: watch the DOM and (re)inject the panel across Atlassian's React re-renders / SPA nav ---- */
(function () {
    if (JITA_IS_FORGE_FRAME) { return; }  // inside the Zendesk Forge iframe we only run the responses dropdown
    if (!window.indexedDB) { return; }   // feature unavailable in this environment
    var scheduled = false;
    var observer = new MutationObserver(function () {
        if (scheduled) { return; }
        scheduled = true;
        setTimeout(function () {
            scheduled = false;
            try { JiTA.ui.ensure(); } catch (e) { /* swallow */ }
            try { JiTA.ui.updateVisibility(); } catch (e2) { /* swallow */ }   // hide while an attachment viewer is open
            try { JiTA.logsig.updateVisibility(); } catch (e3) { /* swallow */ }   // drop the "Defects in log" panel once the log viewer closes
        }, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // also try once on load in case the breadcrumb is already present
    setTimeout(function () { try { JiTA.ui.ensure(); } catch (e) { /* swallow */ } }, 1500);
    // one-time data-schema migration: re-fetch a local DB that predates a stored-field change. Runs before
    // the scheduler's startup tick (below) so its full re-fetch grabs the single-flight lock first.
    setTimeout(function () { try { JiTA.migrate.run(); } catch (e) { /* swallow */ } }, 4000);
    // Keep the hidden set in sync across tabs: another tab hiding/unhiding an issue invalidates our cached map
    // and re-renders the open view so a just-hidden suggestion drops out (and an unhidden one comes back).
    if (typeof GM_addValueChangeListener === 'function') {
        try {
            GM_addValueChangeListener('sdHidden', function (name, oldV, newV, remote) {
                JiTA.hidden._map = null;   // force a reload from storage on the next read
                if (remote) { try { JiTA.ui._rerenderCurrent(); } catch (e) { /* ignore */ } }
            });
        } catch (e) { /* ignore */ }
    }
    // start the periodic background catch-up sync
    JiTA.sched.start();
})();


/* ---- canned responses: inject the dropdown into the Zendesk Support panel ---- */
// Runs in EVERY frame (the main Jira page AND the Forge iframe), because the Zendesk Support panel can be
// rendered EITHER as UI Kit 2 native components in the main page OR inside the cross-origin Forge iframe -
// we don't assume which, so the injector simply feature-detects the ticket selector wherever it lives. It's
// cheap: inject() early-exits unless #ticket-select is present, so it's a no-op in frames without the panel.
(function () {
    var scheduled = false;
    function tick() { try { JiTA.responses.inject(); } catch (e) { /* ignore */ } }
    // Re-inject across the panel's React re-renders / lazy tab load / ticket switches. The Zendesk tab isn't
    // selected by default, so the panel mounts only once the user navigates to it - the observer catches that.
    var obs = new MutationObserver(function () {
        if (scheduled) { return; }
        scheduled = true;
        setTimeout(function () { scheduled = false; tick(); }, 250);
    });
    try { obs.observe(document.documentElement || document.body, { childList: true, subtree: true }); } catch (e) { /* ignore */ }
    // Live-update the dropdown when the repository is edited from the settings menu (another frame).
    if (typeof GM_addValueChangeListener === 'function') {
        try {
            GM_addValueChangeListener('ejfCannedResponses', function () {
                var sel = document.getElementById('jita-resp-select');
                if (sel) { sel.removeAttribute('data-jita-sig'); JiTA.responses._fill(sel); }
            });
        } catch (e) { /* ignore */ }
    }
    setTimeout(tick, 800);   // initial attempt in case the panel is already rendered
})();
