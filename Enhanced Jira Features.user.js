// ==UserScript==
// @name        Enhanced Jira Features
// @version     2.13.7
// @author      ISD BH Schogol, ISD Tulwar
// @description Adds a Translate, Assign to GM, Convert to Defect and Close button to Jira, parses Log Files submitted from the EVE client, suggests similar existing defects on bug reports, and (on a defect) lists the open bug reports that best match it
// @updateURL   https://github.com/Schogol/Enhanced-Jira/raw/main/Enhanced%20Jira%20Features.user.js
// @downloadURL https://github.com/Schogol/Enhanced-Jira/raw/main/Enhanced%20Jira%20Features.user.js
// @match       https://fenriscreations.atlassian.net/jira*
// @match       https://fenriscreations.atlassian.net/browse*
// @match       https://fenriscreations.atlassian.net/issues*
// @require     https://gist.github.com/raw/2625891/waitForKeyElements.js
// @require     https://ajax.googleapis.com/ajax/libs/jquery/3.3.1/jquery.min.js
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



// Creating various variables which we use later on
var rows, oc, lc, pdm, pdmdata, driverAge = "unknown", menu_settings, menu_parser, menu_scrollbar, menu_buttons, menu_similarDefects, menu_sdSync, menu_sdRebuild, menu_sdBackend, menu_sdSyncEbr;


// Current Date
var today = new Date();


// Array which contains the locally saved values for a couple of variables.
// NOTE: index 3 ("dropdowns") is a RETIRED feature (Linked Issue Dropdowns, removed because Jira's markup
// changed and it stopped working). The slot is kept as a placeholder so the later indices (4 = buttons,
// 5 = similarDefects), which are referenced by number throughout this file, don't shift.
var savedVariables = [["key",""], ["parser", ""], ["scrollbar", ""], ["dropdowns_retired", ""], ["buttons", ""], ["similarDefects", ""]];


// Listener which triggers when the locally saved "scrollbar" value is changed. If the new value is false we remove the custom scrollbar. If the new value is true we add the custom scrollbar.
GM_addValueChangeListener("scrollbar", function(key, oldValue, newValue, remote) {
    if (!newValue) {
        $('style:contains("*::-webkit-scrollbar { width: 11px !important; height: 11px !important;}")').remove();
    } else {
        GM_addStyle(
            '*::-webkit-scrollbar { width: 11px !important; height: 11px !important;}\
*::-webkit-scrollbar-thumb { border-radius: 10px !important; background: linear-gradient(left, #96A6BF, #63738C) !important;box-shadow: inset 0 0 1px 1px #828f9e !important;}\
.notion-scroller.horizontal { margin-bottom: 30px !important;}\
.notion-scroller.vertical { margin-bottom: 0px !important;}'
        );
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
        // Similar Defects (index 5) is a BETA feature - default it OFF so it stays opt-in: a fresh install
        // won't silently start downloading the embedding model + building the local defect DB. Everything
        // else defaults ON. (Existing users keep whatever they already set; this only affects unset values.)
        GM_setValue (savedVariables[i][0], (i === 5) ? false : true);
        savedVariables[i][1] = GM_getValue (savedVariables[i][0], "");
    }
}


// Activate a custom scrollbar if the scrollbar value is set to true
if (savedVariables[2][1]) {
    GM_addStyle(
`*::-webkit-scrollbar { width: 11px !important; height: 11px !important;}\
*::-webkit-scrollbar-thumb { border-radius: 10px !important; background: linear-gradient(left, #96A6BF, #63738C) !important;box-shadow: inset 0 0 1px 1px #828f9e !important;}\
.notion-scroller.horizontal { margin-bottom: 30px !important;}\
.notion-scroller.vertical { margin-bottom: 0px !important;}`
    );
};


// Single Tampermonkey menu entry. All feature toggles and Triage Assistant actions (sync / rebuild /
// embedding backend) live in an in-page settings overlay (EJF_SD.menu) instead of a long flat list of GM
// menu commands. The callback references EJF_SD lazily, so it's fine that the namespace is defined later.
menu_settings = GM_registerMenuCommand("⚙ Enhanced Jira – Settings…", function () {
    if (typeof EJF_SD !== 'undefined' && EJF_SD.menu) { EJF_SD.menu.open(); }
});


// Switch the embedding backend between GPU (WebGPU - fast but has been unstable on some GPUs/drivers) and
// CPU (WASM - slow but rock-solid). The choice is persisted in GM flags that EJF_SD.embed.load() reads:
// `sdTryWebgpu` opts into WebGPU, and `sdForceCpu` is the sticky lock the embed pass sets after a GPU device
// loss. Switching to GPU clears that lock so WebGPU is actually retried. We reload afterwards so the pipeline
// rebuilds cleanly on the chosen backend - embedding is resumable, so a reload never loses progress, and any
// already-stored vectors stay valid (same model/version; q8 vs fp32 is just minor quantization noise).
function toggleEmbedBackend() {
    var gpuOn = (typeof GM_getValue !== 'function') || (GM_getValue('sdTryWebgpu', true) && !GM_getValue('sdForceCpu', false));
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
    if (typeof EJF_SD !== 'undefined' && EJF_SD.menu && EJF_SD.menu.isOpen()) { EJF_SD.menu.render(); }
}


/*
// This function could replace the following 4 functions if Tampermonkey accepted parameters in the GM_registerMenuCommand function

function toggleFeature(i) {
    savedVariables[i][1] = savedVariables[i][1] ? false : true;
    GM_setValue (savedVariables[i][0], savedVariables[i][1]);
};
*/


// Function which toggles between true and false for the parser variable and saves it locally
function toggleParser() {
    savedVariables[1][1] = savedVariables[1][1] ? false : true;
    GM_setValue (savedVariables[1][0], savedVariables[1][1]);
    refreshMenu();
};


// Function which toggles between true and false for the scrollbar variable and saves it locally
function toggleScrollbar() {
    savedVariables[2][1] = savedVariables[2][1] ? false : true;
    GM_setValue (savedVariables[2][0], savedVariables[2][1]);
    refreshMenu();
};


// Function which toggles between true and false for the buttons variable and saves it locally
function toggleButtons() {
    savedVariables[4][1] = savedVariables[4][1] ? false : true;
    GM_setValue (savedVariables[4][0], savedVariables[4][1]);
    refreshMenu();
};


// Function which toggles the "Similar Defects" suggestions feature on / off and saves it locally.
// When turned off we also remove the panel immediately.
function toggleSimilarDefects() {
    savedVariables[5][1] = savedVariables[5][1] ? false : true;
    GM_setValue (savedVariables[5][0], savedVariables[5][1]);
    if (!savedVariables[5][1]) {
        $('#ejf-sd-panel').remove();
        $('#ejf-side-group').remove();
        if (typeof EJF_SD !== 'undefined') { EJF_SD.ui.currentKey = null; }
    } else if (typeof EJF_SD !== 'undefined') {
        EJF_SD.ui.ensure();
    }
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


// Check if the issue is a Bug report. If it is then we add the extra buttons
function checkIssueType() {
    if ($('a[data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]:contains("EBR")').length > 0 && savedVariables[4][1]) {
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
    if (!$('a[data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]:contains("EBR")').length) { return; } // not a bug report
    if (!$('button[data-testid="issue-view-foundation.quick-add.quick-add-items-compact.apps-button-dropdown--trigger"]').length) { return; } // action bar not ready yet
    addButtons();
}

// Throttle: a single issue-view re-render fires a burst of mutations, so we coalesce them and run the
// (cheap, early-exiting) check at most once every 200ms rather than on every individual mutation.
var ejfButtonGuardScheduled = false;
var ejfButtonObserver = new MutationObserver(function () {
    if (ejfButtonGuardScheduled) { return; }
    ejfButtonGuardScheduled = true;
    setTimeout(function () {
        ejfButtonGuardScheduled = false;
        ensureButtonsPresent();
        try { ejfShowIssueDates(); } catch (e) { /* ignore */ }   // mirror Created/Updated into the top header
        try { ejfHideNativeDates(); } catch (e) { /* ignore */ }   // ...and hide Jira's native bottom timestamps
    }, 200);
});
ejfButtonObserver.observe(document.body, { childList: true, subtree: true });


// ---- Surface the issue's Created / Updated dates at the TOP of the header ----
// Jira only renders Created/Updated ("N ago") at the very BOTTOM of the right context column, so you have to
// scroll to see them. Mirror them into the top header bar (the empty space between the breadcrumb and the
// lock / watch / share / … action icons) so they're visible at a glance. Same-origin REST read, cached per
// issue. Always on for issue pages; cheap early-exit once mounted for the current issue.
var ejfDatesCache = {};   // issueKey -> { created, updated } ISO strings
function ejfFmtDateShort(iso) {
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
function ejfDatesTarget() {
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

function ejfShowIssueDates() {
    var bc = document.querySelector('a[data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]');
    if (!bc) {   // not on an issue page -> drop any stale element
        var gone = document.getElementById('ejf-issue-dates');
        if (gone && gone.parentNode) { gone.parentNode.removeChild(gone); }
        return;
    }
    var key = (bc.textContent || '').trim();
    if (!key) { return; }
    var existing = document.getElementById('ejf-issue-dates');
    if (existing && existing.getAttribute('data-key') === key && existing.isConnected) { return; }   // already shown for this issue
    var tgt = ejfDatesTarget();
    if (!tgt) { return; }   // header not ready yet; the observer will retry
    if (existing && existing.parentNode) { existing.parentNode.removeChild(existing); }

    var el = document.createElement('div');
    el.id = 'ejf-issue-dates';
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
            val.textContent = ejfFmtDateShort(iso);
            val.style.marginLeft = 'auto';   // push the date to the right edge of the (stretched) row
            row.appendChild(lbl);
            row.appendChild(val);
            el.appendChild(row);
        }
        part('Created', created);
        part('Updated', updated);
    }

    if (ejfDatesCache[key]) { paint(ejfDatesCache[key].created, ejfDatesCache[key].updated); return; }
    $.ajax({ url: 'https://fenriscreations.atlassian.net/rest/api/2/issue/' + key + '?fields=created,updated', dataType: 'json' })
        .done(function (d) {
            var f = (d && d.fields) || {};
            ejfDatesCache[key] = { created: f.created || null, updated: f.updated || null };
            paint(ejfDatesCache[key].created, ejfDatesCache[key].updated);
        })
        .fail(function () { if (el.isConnected) { el.textContent = ''; } });
}

// Jira renders the issue's Created/Updated timestamps a second time at the very BOTTOM of the right context
// column (the spot you'd otherwise have to scroll to). Now that we mirror them into the top header, hide that
// native block so the date isn't shown twice. Jira gives those rows stable testids
// ("created-date.ui.read.meta-date" / "updated-date.ui.read.meta-date"), so we target them directly. Idempotent.
function ejfHideNativeDates() {
    var nodes = document.querySelectorAll(
        '[data-testid="created-date.ui.read.meta-date"], [data-testid="updated-date.ui.read.meta-date"],' +
        ' [data-testid$="-date.ui.read.meta-date"]');
    for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n.getAttribute('data-ejf-hidden-dates')) { continue; }   // already hidden
        n.style.display = 'none';
        n.setAttribute('data-ejf-hidden-dates', '1');
    }
}

// Initial nudge in case the header is already present before the first DOM mutation fires.
waitForKeyElements(issueItem, function () {
    try { ejfShowIssueDates(); } catch (e) { /* ignore */ }
    try { ejfHideNativeDates(); } catch (e) { /* ignore */ }
});


// Free translation via Google's keyless "gtx" endpoint (translate_a/single). No API key, no cost - this
// replaces the old paid Cloud Translation v2 API that kept hitting the free-tier quota. We POST (rather
// than GET) so a long EVE description can't blow the URL length limit, and go through GM_xmlhttpRequest so
// CORS is a non-issue (no session cookie needed). Source language is auto-detected (sl=auto -> tl=en).
// Resolves to: the translated string, '' for empty input, or null on failure (HTTP error / throttle / parse).
function ejfTranslateFree(text) {
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


// Adds the different buttons to the "command-bar" and defines what they do
function addButtons() {
    // Variable which contains the current Issue ID which we need
    var issueID = $('a[data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]').text();

    // Grabbing the button and span class for the buttons (which constantly changes because react + atlassian ~_~)
    let buttonClass = $('button[data-testid="issue-view-foundation.quick-add.quick-add-items-compact.apps-button-dropdown--trigger"]').attr('class');
    let innerSpanClass = $('button[data-testid="issue-view-foundation.quick-add.quick-add-items-compact.apps-button-dropdown--trigger"]').find('span').eq(0).attr('class');
    let iconSpanClass = $('button[data-testid="issue-view-foundation.quick-add.quick-add-items-compact.apps-button-dropdown--trigger"]').find('span').eq(1).attr('class');
    let labelSpanClass = $('button[data-testid="issue-view-foundation.quick-add.quick-add-items-compact.apps-button-dropdown--trigger"]').find('span').eq(2).attr('class');

    // Jira cloud ID which we need for some of the POST requests we send
    let ajscloudid = $('meta[name="ajs-cloud-id"]').attr('content');


    // Create Translate Button
if ($('#translateButton').length === 0) {
  var translateButton = $(
    '<button id="translateButton" type="button" tabindex="1" class="' + buttonClass + '" ' +
    'style="margin-left: 8px; width: fit-content; padding: 6px 8px 6px 3px; white-space: nowrap; display: inline-flex; align-items: center;">' +
    '<span class="' + innerSpanClass + '"></span>' +
    '<span style="font-size: 13px;">Translate</span>' +
    '</button>'
    );
    $('button[data-testid="issue-view-foundation.quick-add.quick-add-items-compact.apps-button-dropdown--trigger"]').after(translateButton);
    }

    // When the translate button is clicked we translate the Issue title + description blocks to English via
    // Google's FREE keyless gtx endpoint (ejfTranslateFree). One request per text, run in parallel, then we
    // replace the original Title / Description / Repro-Steps with the translation - same DOM mapping as before.
    $("#translateButton").click(function () {
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
        Promise.all([ejfTranslateFree(titleText), ejfTranslateFree(d0), ejfTranslateFree(d1)])
            .then(function (tr) {
                // null == request failed (HTTP error / throttle / parse); all-null means nothing came back.
                if (tr[0] === null && tr[1] === null && tr[2] === null) {
                    alert("Cannot get translation - Google may be rate-limiting. Wait a moment and try again.\r\nReport issues to Schogol :).");
                    return;
                }
                if (tr[0]) { $title.text(tr[0]); }
                if (tr[1]) { setBlockText($desc.children().eq(0), tr[1]); }
                if (tr[2]) { setBlockText($desc.children().eq(1), tr[2]); }
            });
    });


    // Create GM Button
if ($('#GMButton').length === 0) {
  var GMButton = $(
    '<button id="GMButton" aria-label="GMButton" class="' + buttonClass + '" type="button" tabindex="1" ' +
    'style="margin-left: 8px; width: fit-content; padding: 6px 8px 6px 3px; white-space: nowrap; display: inline-flex; align-items: center;">' +
    '<span class="' + innerSpanClass + '"></span>' +
    '<span style="font-size: 13px;">Assign to GM</span>' +
    '</button>'
    );
    $('button[data-testid="issue-view-foundation.quick-add.quick-add-items-compact.apps-button-dropdown--trigger"]').after(GMButton);
    }

    // When the Assign to GM button is clicked we change the Team to "EO - Game Masters" and also visually change the field so the user sees that it worked.
    $("#GMButton").click(function () {
        $.ajax({
            url: 'https://fenriscreations.atlassian.net/rest/api/2/issue/'+ $('a[data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]').text(),
            type: 'PUT',
            contentType: 'application/json',
            charset: 'utf-8',
            data: '{"fields":{"customfield_10001":"38"}}',

            // When the change of the team via API is successful we change the Team visually for the user to also see that as the Issue doesnt update automatically
            success: function (data) {
                $('div[data-testid="issue-field-heading-styled-field-heading.field"]:contains(Team)').parent().children('div').eq(1).text('EO - GameMasters');
                // After changing the Team field to "EO - Game Masters" we change the Assignee field to "Unassigned" because GMs wont be able to see the BRs in their filters if they are assigned to someone.
                $.ajax({
                    url: 'https://fenriscreations.atlassian.net/rest/api/3/issue/'+ $('a[data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]').text() + '/assignee',
                    type: 'PUT',
                    contentType: 'application/json',
                    charset: 'utf-8',
                    data: '{"accountId":null}',

                    success: function (data) {
                        $('div[data-testid="issue-field-heading-styled-field-heading.assignee"]:contains(Assignee)').parent().children('div').eq(1).text('Unassigned');
                    },

                    // If we get an Error we annoy the user by telling them that it failed and to check their Dev Console for errors
                    error: function(data){
                        console.log(JSON.stringify(data));
                        alert("Wasn't able to change Assignee field to 'Unassigned'. Check Console for errors and report issues to Schogol :).");
                    }
                });

            },

            // If we get an Error then we annoy the user by telling them that it failed and to check their Dev Console for errors
            error: function(data){
                console.log(JSON.stringify(data));
                alert("This failed for some reason. Check Console for errors and report issues to Schogol :).");
            }
        })
    });



    // Create Convert To Defect Button
if ($('#convertToDefectButton').length === 0) {
  var convertToDefectButton = $(
    '<button id="convertToDefectButton" aria-label="ConvertToDefect" class="' + buttonClass + '" type="button" tabindex="0" ' +
    'style="margin-left: 8px; width: fit-content; padding: 6px 8px 6px 3px; white-space: nowrap; display: inline-flex; align-items: center;">' +
    '<span class="' + innerSpanClass + '"></span>' +
    '<span style="font-size: 13px;">Convert to Defect</span>' +
    '</button>'
    );
    $('button[data-testid="issue-view-foundation.quick-add.quick-add-items-compact.apps-button-dropdown--trigger"]').after(convertToDefectButton);
    }
    // When the Convert to Defect button is clicked we trigger the Automation which converts the EBR into an EDR issue
    $("#convertToDefectButton").click(function () {
        let ajscloudid = $('meta[name="ajs-cloud-id"]').attr('content');
        $.ajax({
            url: 'https://fenriscreations.atlassian.net/rest/api/2/issue/'+ issueID +'',
            type: 'GET',
            contentType: 'application/json',
            charset: 'utf-8',
            data: '',

            success: function (data) {
                $.ajax({
                    url: 'https://fenriscreations.atlassian.net/gateway/api/automation/internal-api/jira/' + ajscloudid + '/pro/rest/v1/rules/manual/invocation/767335',
                    type: 'POST',
                    contentType: 'application/json',
                    charset: 'utf-8',
                    data: '{"objects":["ari:cloud:jira:' + ajscloudid + ':issue/' + data.id + '"]}',
                    //Old:
                    //data: '{"targetIssueKeys":["' + issueID + '"]}',

            // Once the conversion succeeds we check for the "Issue Updated" message on screen and once it appears we refresh the page
            success: function (data) {
                var t=setInterval(function () {if ($('strong:contains(Issue Updated)')[0]) {clearInterval(t);window.location.reload(false);}},500);
            },

            // If we get an Error then we annoy the user by telling them that it failed and to check their Dev Console for errors
            error: function(data){
                console.log(JSON.stringify(data));
                alert("This failed for some reason. Check Console for errors and report issues to Schogol :).");
            }
        })
            },

            // If we get an Error then we annoy the user by telling them that it failed and to check their Dev Console for errors
            error: function(data){
                console.log(JSON.stringify(data));
                alert("This failed for some reason. Check Console for errors and report issues to Schogol :).");
            }
        })
    });


    // Create close button
if ($('#closeButton').length === 0) {
  var closeButton = $(
    '<button id="closeButton" aria-label="Close Button" class="' + buttonClass + '" type="button" tabindex="1" ' +
    'style="margin-left: 8px; width: fit-content; padding: 6px 8px 6px 3px; white-space: nowrap; display: inline-flex; align-items: center;">' +
    '<span class="' + innerSpanClass + '"></span>' +
    '<span style="font-size: 13px;">Close</span>' +
    '</button>'
    );
    $('button[data-testid="issue-view-foundation.quick-add.quick-add-items-compact.apps-button-dropdown--trigger"]').after(closeButton);
    }
    // When the Close button is clicked we change the status to Closed by simulating clicks on the relevant buttons. This is extremely janky right now because I cant figure out a better way to do this.
    $("#closeButton").click(function () {
        $("div[data-testid='issue.views.issue-base.foundation.status.status-field-wrapper']").find("button").click()
        setTimeout(function(){$("div[data-testid='issue.fields.status.common.ui.status-lozenge.3']").children().find("span:contains(Closed)").click();}, 100);
    });
};


// Adds the "toggleText()" function to jQuery which lets you easily toggle between two given texts
$.fn.extend({
    toggleText: function(a, b){
        return this.text(this.text() == b ? a : b);
    }
});


// When we detect the "title row" of a log parser file then we swap out the content of the log file with a parsed, more readable version of it with some extra features like buttons which allow you to toggle the visibility of certain types of events
var selector = "span[data-testid='code-block']:contains(Time	Facility	Type	Message)";
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
var cmSelector = ".cm-line:contains(Time\tFacility\tType\tMessage)";
waitForKeyElements(cmSelector, SwapUI);


// When we detect the oustandingCalls.txt file link inside the igbr.zip then we run the addClickEvent function
var ocSelector = 'span[data-item-title="true"]:contains(outstandingcalls.txt)';
waitForKeyElements(ocSelector, addClickEvent);


// When we detect the lastCrashes.txt file link inside the igbr.zip then we run the addClickEvent2 function
var lcSelector = 'span[data-item-title="true"]:contains(lastcrashes.txt)';
waitForKeyElements(lcSelector, addClickEvent2);


// When we detect the PDMData.txt file link inside the igbr.zip then we run the addClickEvent3 function
var pdmSelector = 'span[data-item-title="true"]:contains(PDMData.txt)';
waitForKeyElements(pdmSelector, addClickEvent3);


//Once we click on the outstandingcalls.txt we set the oc variable to true and run the SwapUI function after 750ms (to give it some time to load)
function addClickEvent() {
    $("button:contains('outstandingcalls.txt')").on('click', function() {oc = true; setTimeout(SwapUI, 750)});
}


//Once we click on the lastcrashes.txt we set the lc variable to true and run the SwapUI function after 750ms (to give it some time to load)
function addClickEvent2() {
    $("button:contains('lastcrashes.txt')").on('click', function() {lc = true; setTimeout(SwapUI, 750)});
}


//Once we click on the PDMData.txt we set the pdm variable to true and run the SwapUI function after 750ms (to give it some time to load)
function addClickEvent3() {
    $("button:contains('PDMData.txt')").on('click', function() {pdm = true; setTimeout(SwapUI, 750)});
}


// Reads the complete text of a file rendered by the new CodeMirror-based viewer.
// CodeMirror only keeps the lines currently in view inside the DOM, but it holds the whole document
// in its in-memory editor state. The userscript sandbox can't reach CodeMirror's internal DOM property,
// so we run the read in the page context via an injected <script> and hand the text back through a
// shared, hidden DOM node (which both contexts can see).
function getCmDocText() {
    var NODE_ID = 'EJF_cmdoc_transfer';

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
        'var c=document.querySelector(".cm-content");' +
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


// Swap out the UI when looking at a log file and add the buttons to toggle message types at the top of the page
function SwapUI() {
    // --- New CodeMirror-based viewer (files attached directly to the report) ---
    // Detect the file type from its (always-rendered) header row, pull the complete text straight out of
    // CodeMirror's state, drop our parser UI into the editor container, then reuse the existing parsers.
    // Files inside the igbr.zip still use the old <span> layout and are handled by the original code below.
    if ($('.cm-content').length && !$("span[data-testid='code-block']").length && savedVariables[1][1]
        && $(".cm-line:contains(Time\tFacility\tType\tMessage)")[0]) {
        rows = getCmDocText();
        $('.cm-editor').html(html);
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

    else if ($("span[data-testid='code-block']:contains(Time	Facility	Type	Message)")[0] && savedVariables[1][1]) {
        $('code > span:empty').remove();
        $('span[data-testid="code-block"]').find('span > span.comment').remove();
        rows = $("span[data-testid='code-block']").text();
        $("span[data-testid='code-block']").html(html);
        setTimeout(ParseLogs, 250);
    }

    else if ($("span[data-testid='code-block']:contains(dateTime	pyDateTime	procCpu	threadCpu	pyMem	virtualMem	taskletsProcessed	taskletsQueued	watchdog time	spf	serviceCalls	callsFromClient	bytesReceived	bytesSent	packetsReceived	packetsSent	sessionCount	tidiFactor)")[0] && savedVariables[1][1]) {
        $('code > span:empty').remove();
        $('span[data-testid="code-block"]').find('span > span.comment').remove();
        rows = $("span[data-testid='code-block']").text();
        $("span[data-testid='code-block']").html(phHtml);
        setTimeout(ParsePhLogs, 250);
    }

    else if ($("span[data-testid='code-block']:contains(Time	Method	Duration [ms])")[0] && savedVariables[1][1]) {
        $('code > span:empty').remove();
        $('span[data-testid="code-block"]').find('span > span.comment').remove();
        rows = $("span[data-testid='code-block']").text();
        $("span[data-testid='code-block']").html(McHtml);
        setTimeout(ParseMcLogs, 250);
    }

    else if (oc && savedVariables[1][1]) {
        $('code > span:empty').remove();
        $('span[data-testid="code-block"]').find('span > span.comment').remove();
        rows = $("span[data-testid='code-block']").text();
        $("span[data-testid='code-block']").html(ocHtml);
        oc = false;
        setTimeout(ParseOcLogs, 250);
    }

    else if (lc && savedVariables[1][1]) {
        $('code > span:empty').remove();
        $('span[data-testid="code-block"]').find('span > span.comment').remove();
        rows = $("span[data-testid='code-block']").text();
        $("span[data-testid='code-block']").html(lcHtml);
        lc = false;
        setTimeout(ParseOcLogs, 250);
    }

    else if (pdm && savedVariables[1][1]) {
        $('code > span:empty').remove();
        $('span[data-testid="code-block"]').find('span > span.comment').remove();
        rows = $("span[data-testid='code-block']").text();
        $("span[data-testid='code-block']").append(pdmHtml);
        pdmdata = convertTextToObject(rows);

        switch (pdmdata.DATA.OS.TYPE) {
            case "Windows":
                switch (true) {
                    case ((Number(pdmdata.DATA.OS.BUILD_NUMBER) >= Number(recRequirements.OS.Windows.BuildNo)) && (pdmdata.DATA.MACHINE.CPU.VENDOR == "AuthenticAMD") && (Number(pdmdata.DATA.MACHINE.CPU.LOGICAL_CORE_COUNT) >= Number(recRequirements.CPU.AMD.Cores)) && (Number(pdmdata.DATA.MACHINE.CPU.FREQUENCY_MHZ) >= Number(recRequirements.CPU.AMD.Frequency)) && (Number(pdmdata.DATA.OS.GRAPHICS_APIS.D3D_HIGHEST_SUPPORT) >= Number(recRequirements.Graphics.D3D_SUPPORT)) && (Number(pdmdata.DATA.MACHINE.GPUS.GPU.VIDEO_MEMORY) >= Number(recRequirements.Graphics.Video_Memory)) && (Number(pdmdata.DATA.MACHINE.TOTAL_MEMORY) >= Number(recRequirements.RAM))) : $('#Requirements').html('This PC <u><b>does</b></u> meet the recommended requirements for EVE.'); break;
                    case ((Number(pdmdata.DATA.OS.BUILD_NUMBER) >= Number(minRequirements.OS.Windows.BuildNo)) && (pdmdata.DATA.MACHINE.CPU.VENDOR == "AuthenticAMD") && (Number(pdmdata.DATA.MACHINE.CPU.LOGICAL_CORE_COUNT) >= Number(minRequirements.CPU.AMD.Cores)) && (Number(pdmdata.DATA.MACHINE.CPU.FREQUENCY_MHZ) >= Number(minRequirements.CPU.AMD.Frequency)) && (Number(pdmdata.DATA.OS.GRAPHICS_APIS.D3D_HIGHEST_SUPPORT) >= Number(minRequirements.Graphics.D3D_SUPPORT)) && (Number(pdmdata.DATA.MACHINE.GPUS.GPU.VIDEO_MEMORY) >= Number(minRequirements.Graphics.Video_Memory)) && (Number(pdmdata.DATA.MACHINE.TOTAL_MEMORY) >= Number(minRequirements.RAM))) : $('#Requirements').html('This PC <u><b>does</b></u> meet the minimum requirements for EVE.'); break;
                    case ((Number(pdmdata.DATA.OS.BUILD_NUMBER) >= Number(recRequirements.OS.Windows.BuildNo)) && (pdmdata.DATA.MACHINE.CPU.VENDOR == "GenuineIntel") && (Number(pdmdata.DATA.MACHINE.CPU.LOGICAL_CORE_COUNT) >= Number(recRequirements.CPU.Intel.Cores)) && (Number(pdmdata.DATA.MACHINE.CPU.FREQUENCY_MHZ) >= Number(recRequirements.CPU.Intel.Frequency)) && (Number(pdmdata.DATA.OS.GRAPHICS_APIS.D3D_HIGHEST_SUPPORT) >= Number(recRequirements.Graphics.D3D_SUPPORT)) && (Number(pdmdata.DATA.MACHINE.GPUS.GPU.VIDEO_MEMORY) >= Number(recRequirements.Graphics.Video_Memory)) && (Number(pdmdata.DATA.MACHINE.TOTAL_MEMORY) >= Number(recRequirements.RAM))) : $('#Requirements').html('This PC <u><b>does</b></u> meet the recommended requirements for EVE.'); break;
                    case ((Number(pdmdata.DATA.OS.BUILD_NUMBER) >= Number(minRequirements.OS.Windows.BuildNo)) && (pdmdata.DATA.MACHINE.CPU.VENDOR == "GenuineIntel") && (Number(pdmdata.DATA.MACHINE.CPU.LOGICAL_CORE_COUNT) >= Number(minRequirements.CPU.Intel.Cores)) && (Number(pdmdata.DATA.MACHINE.CPU.FREQUENCY_MHZ) >= Number(minRequirements.CPU.Intel.Frequency)) && (Number(pdmdata.DATA.OS.GRAPHICS_APIS.D3D_HIGHEST_SUPPORT) >= Number(minRequirements.Graphics.D3D_SUPPORT)) && (Number(pdmdata.DATA.MACHINE.GPUS.GPU.VIDEO_MEMORY) >= Number(minRequirements.Graphics.Video_Memory)) && (Number(pdmdata.DATA.MACHINE.TOTAL_MEMORY) >= Number(minRequirements.RAM))) : $('#Requirements').html('This PC <u><b>does</b></u> meet the minimum requirements for EVE.'); break;
                    default: $('#Requirements').html('This PC <u><b>does not</u></b> meet the minimum requirements for EVE.');
                }
                break;
            case "macOS":
                switch (true) {
                    case ((Number(pdmdata.DATA.OS.MAJOR_VERSION + "." + pdmdata.DATA.OS.MINOR_VERSION) >= Number(recRequirements.OS.Mac.MajorVersion + "." + recRequirements.OS.Mac.MinorVersion)) && (pdmdata.DATA.MACHINE.CPU.VENDOR == "GenuineIntel") && (Number(pdmdata.DATA.MACHINE.CPU.LOGICAL_CORE_COUNT) >= Number(recRequirements.CPU.Intel.Cores)) && (Number(pdmdata.DATA.MACHINE.CPU.FREQUENCY_MHZ) >= Number(recRequirements.CPU.Intel.Frequency)) && (Number(pdmdata.DATA.MACHINE.TOTAL_MEMORY) >= Number(recRequirements.RAM))) : $('#Requirements').html('This PC <u><b>does</b></u> meet the recommended requirements for EVE.'); break;
                    case ((Number(pdmdata.DATA.OS.MAJOR_VERSION + "." + pdmdata.DATA.OS.MINOR_VERSION) >= Number(recRequirements.OS.Mac.MajorVersion + "." + recRequirements.OS.Mac.MinorVersion)) && (pdmdata.DATA.MACHINE.CPU.VENDOR == "Apple") && (Number(pdmdata.DATA.MACHINE.CPU.LOGICAL_CORE_COUNT) >= Number(recRequirements.CPU.Apple.Cores)) && (Number(pdmdata.DATA.MACHINE.TOTAL_MEMORY) >= Number(recRequirements.RAM))) : $('#Requirements').html('This PC <u><b>does</b></u> meet the recommended requirements for EVE.'); break;
                    case ((Number(pdmdata.DATA.OS.MAJOR_VERSION + "." + pdmdata.DATA.OS.MINOR_VERSION) >= Number(minRequirements.OS.Mac.MajorVersion + "." + minRequirements.OS.Mac.MinorVersion)) && (pdmdata.DATA.MACHINE.CPU.VENDOR == "GenuineIntel") && (Number(pdmdata.DATA.MACHINE.CPU.LOGICAL_CORE_COUNT) >= Number(minRequirements.CPU.Intel.Cores)) && (Number(pdmdata.DATA.MACHINE.CPU.FREQUENCY_MHZ) >= Number(minRequirements.CPU.Intel.Frequency)) && (Number(pdmdata.DATA.MACHINE.TOTAL_MEMORY) >= Number(minRequirements.RAM))) : $('#Requirements').html('This PC <u><b>does</b></u> meet the minimum requirements for EVE.'); break;
                    case ((Number(pdmdata.DATA.OS.MAJOR_VERSION + "." + pdmdata.DATA.OS.MINOR_VERSION) >= Number(minRequirements.OS.Mac.MajorVersion + "." + minRequirements.OS.Mac.MinorVersion)) && (pdmdata.DATA.MACHINE.CPU.VENDOR == "Apple") && (Number(pdmdata.DATA.MACHINE.CPU.LOGICAL_CORE_COUNT) >= Number(minRequirements.CPU.Apple.Cores)) && (Number(pdmdata.DATA.MACHINE.TOTAL_MEMORY) >= Number(minRequirements.RAM))) : $('#Requirements').html('This PC <u><b>does</b></u> meet the minimum requirements for EVE.'); break;
                    default: $('#Requirements').html('This PC <u><b>does not</u></b> meet the minimum requirements for EVE.');
                }
                break;
            default:
                $('#Requirements').html('This PC <u><b>does not</b></u> meet the minimum requirements for EVE.<div>Reason: Unsupported Operating System</div>');
        }
        var driverDate = pdmdata.DATA.MACHINE.GPUS.GPU.DRIVER.DATE.split("-");
        driverDate = Date.parse(driverDate[2]+"-"+driverDate[0]+"-"+driverDate[1]);
        driverAge = Math.ceil((today - driverDate)/(1000 * 3600 *24));
        $('#driverAge').html('The graphics driver is '+ driverAge +' days old.');
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
    // ejfApplyLogFilter recomputes visibility from the toggle state (including the "Only Exceptions" combo,
    // which also hides info rows) so search and the toggle buttons never fight. Wired only on the main log
    // parser, the one layout that has the search input.
    if ($('#ejf-log-search').length) {
        var ejfApplyLogFilter = function () {
            var q = ($('#ejf-log-search').val() || '').toLowerCase();
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
        };
        var ejfSearchTimer = null;
        $('#ejf-log-search').on('input', function () {
            if (ejfSearchTimer) { clearTimeout(ejfSearchTimer); }
            ejfSearchTimer = setTimeout(ejfApplyLogFilter, 120);   // debounce for large logs
        });
        // Re-apply the text filter after any toggle / Only-Exceptions / Show-All click so the two compose.
        $('#gpanel a').on('click', function () { setTimeout(ejfApplyLogFilter, 0); });
    }
};


// Process the methodcalls logs and display them in a more readable state than the default
function ParseMcLogs() {
    var averageDuration = 0;
    var count = 0;
    var peak = 0;
    rows = rows.replace(/(\t{2,})+/g, "\t").replace(/([\r\n]){2,}/g, "\r\n").replace(/([\r\n])[*]{3}(.*)(?=[*]{3})[*]{3}/g, "\r\n\t\t\tLogging error occurred").replace(/[\<]/g, function(c) {return "&lt;";}).replace(/\n$/, "").split("\n");

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
        for (var i = tableContentRowsLength, row, rowNumber, cellIndex, dateTime, method, duration, macho; i < toIndex; ++i) {
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
    document.getElementById("loader").style.display = "none";
    document.getElementById("tableContent").style.display = "table";
};


// Process the outstandingcalls logs and display them in a more readable state than the default
function ParseOcLogs() {
    rows = rows.replace(/(\t{2,})+/g, "\t").replace(/([\r\n]){2,}/g, "\r\n").replace(/([\r\n])[*]{3}(.*)(?=[*]{3})[*]{3}/g, "\r\n\t\t\tLogging error occurred").replace(/[\<]/g, function(c) {return "&lt;";}).replace(/\n$/, "").split("\n");

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
        for (var i = tableContentRowsLength, row, rowNumber, cellIndex, dateTime, method; i < toIndex; ++i) {
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
    document.getElementById("loader").style.display = "none";
    document.getElementById("tableContent").style.display = "table";
};


// Process the processHealth logs and display them in a more readable state than the default
function ParsePhLogs() {
    rows = rows.replace(/(\t{2,})+/g, "\t").replace(/([\r\n]){2,}/g, "\r\n").replace(/([\r\n])[*]{3}(.*)(?=[*]{3})[*]{3}/g, "\r\n\t\t\tLogging error occurred").replace(/[\<]/g, function(c) {return "&lt;";}).replace(/\n$/, "").split("\n");

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
        for (var i = tableContentRowsLength, row, rowNumber, cellIndex, dateTime, pyDateTime, procCpu, threadCpu, pyMem, virtualMem, taskletsProcessed, taskletsQueued, watchdogTime, spf, serviceCalls, callsFromClient, bytesReceived, bytesSent, packetsReceived, packetsSent, sessionCount, tidiFactor; i < toIndex; ++i) {
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
    document.getElementById("loader").style.display = "none";
    document.getElementById("tableContent").style.display = "table";
};



// Process the logs and display them in a more readable state than the default
function ParseLogs() {
    rows = rows.replace(/(\t{2,})+/g, "\t").replace(/([\r\n]){2,}/g, "\r\n").replace(/([\r\n])[*]{3}(.*)(?=[*]{3})[*]{3}/g, "\r\n\t\t\tLogging error occurred").replace(/[\<]/g, function(c) {return "&lt;";}).replace(/\n$/, "").split("\n");

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
        for (var i = tableContentRowsLength, row, rowNumber, cellIndex, timeCell, facilityCell, typeCell, messageCell, clickHandler; i < toIndex; ++i) {
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
            //  EJF_SD.logsig.applyToTable(), since the signature index is built async from IndexedDB.)


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
    document.getElementById("loader").style.display = "none";
    document.getElementById("tableContent").style.display = "table";

 /**
 * Feature D: flag log lines that match a known exception signature mined from the defect DB, linking each
 * back to its defect. Runs async (index is built from IndexedDB) and patches the rendered rows in place.
 */
    if (typeof EJF_SD !== 'undefined' && EJF_SD.logsig) { EJF_SD.logsig.applyToTable(); }
};


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

    #ejf-log-search {
      height: 26px;
      padding: 0 8px;
      border: 1px solid #555;
      border-radius: 4px;
      background: #1d2125;
      color: #e6e6e6;
      font-size: 12px;
      outline: none;
    }

    #ejf-log-search:focus {
      border-color: #4c9aff;
    }

    .sig-hit {
      box-shadow: inset 4px 0 0 #ffb547 !important;
    }

    .sig-hit-loose {
      box-shadow: inset 4px 0 0 #6b7785 !important;
    }
`


// Variable which contains the UI of the Log Parser
var html = `
<style>
`+ css + cssLogParser +`
</style>

<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<body>
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
            <li id="searchli">
               <input id="ejf-log-search" type="text" placeholder="Filter…" autocomplete="off">
         </ul>
      </nav>
   </header>
   <div id="body">
      <header>
         <h1>Logfile Parser</h1>
      </header>
      <div id="table" tabindex="0">
         <table id="tableContent" style="display:none;" class="fixedHead">
         <div id="loader"></div>
         <thead>
               <tr>
                  <th scope="col">Time
                  <th scope="col">Facility
                  <th scope="col">Type
                  <th scope="col">Message
         </thead>
         <tbody></tbody>
         </table>
      </div>
   </div>
`;



// Variable which contains the UI of the Process Health parser
var phHtml = `
<style>
`+ css +`
</style>

<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<body>
   <div id="body">
      <header>
         <h1>Process Health</h1>
      </header>
      <div id="table" tabindex="0">
         <table id="tableContent" style="display:none;" class="fixedHead">
            <div id="loader"></div>
            <thead>
               <tr>
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
                  <th scope="col">tidiFactor <i class="fa-regular fa-circle-question" title="Time Dilation - 1.0 = No TiDi"></i>
            </thead>
            <tbody></tbody>
         </table>
      </div>
   </div>
`;


// Variable which contains the UI of the Method Calls parser
var McHtml = `
<style>
`+ css +`
</style>

<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<body>
  <header id="gheader">
      <nav id="gpanel">
         <ul id="gnav">
            <li>
               <div id="averageMacho"> Average machoNet::GetTime duration:</div>
               <div id="peakMacho"> Peak machoNet::GetTime duration:</div>
         </ul>
      </nav>
   </header>
   <div id="body">
      <header>
         <h1>Method Calls</h1>
      </header>
      <div id="table" tabindex="0">
         <table id="tableContent" style="display:none;" class="fixedHead">
            <div id="loader"></div>
            <thead>
               <tr>
                  <th scope="col">Time <i class="fa-regular fa-circle-question" title="System date / time converted into UTC"></i>
                  <th scope="col">Method <i class="fa-regular fa-circle-question" title="Python method which was called"></i>
                  <th scope="col">Duration in ms <i class="fa-regular fa-circle-question" title="How long it took to complete the method call"></i>
            </thead>
            <tbody></tbody>
         </table>
      </div>
   </div>
`;


// Variable which contains the UI of the Outstanding Calls parser
var ocHtml = `
<style>
`+ css +`
</style>

<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<body>
   <div id="body">
      <header>
         <h1>Outstanding Calls</h1>
      </header>
      <div id="table" tabindex="0">
         <table id="tableContent" style="display:none;" class="fixedHead">
            <div id="loader"></div>
            <thead>
               <tr>
                  <th scope="col">Time <i class="fa-regular fa-circle-question" title="System date / time converted into UTC"></i>
                  <th scope="col">Method <i class="fa-regular fa-circle-question" title="Python method which was called but is not yet finished"></i>
            </thead>
            <tbody></tbody>
         </table>
      </div>
   </div>
`;


// Variable which contains the UI of the Last Crashes parser
var lcHtml = `
<style>
`+ css +`
</style>

<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<body>
   <div id="body">
      <header>
         <h1>Last Crashes</h1>
      </header>
      <div id="table" tabindex="0">
         <table id="tableContent" style="display:none;" class="fixedHead">
            <div id="loader"></div>
            <thead>
               <tr>
                  <th scope="col">Time <i class="fa-regular fa-circle-question" title="System date / time converted into UTC"></i>
                  <th scope="col">Crash ID
            </thead>
            <tbody></tbody>
         </table>
      </div>
   </div>
`;


// Rough minimum requirements for EVE
var minRequirements = {
    OS: {
        Windows: {
            BuildNo: "7600"
        },
        Mac: {
            MajorVersion: "10",
            MinorVersion: "14"
        }
    },
    CPU: {
        Intel: {
            Cores: "2",
            Frequency: "2000"
        },
        Apple: {
            Cores: "8"
        },
        AMD: {
            Cores: "2",
            Frequency: "2000"
        }
    },
    Graphics: {
        D3D_SUPPORT: "11",
        Video_Memory: "1073741824"
    },
    RAM: "4294967296"
};


// Rough recommended requirements for EVE
var recRequirements = {
    OS: {
        Windows: {
            BuildNo: "10240"
        },
        Mac: {
            MajorVersion: "12",
            MinorVersion: "0",
            Bitness: "x64"
        }
    },
    CPU: {
        Intel: {
            Cores: "4",
            Frequency: "3600"
        },
        Apple: {
            Cores: "10"
        },
        AMD: {
            Cores: "8",
            Frequency: "3000"
        }
    },
    Graphics: {
        D3D_SUPPORT: "11",
        Video_Memory: "8289934592"
    },
    RAM: "17179869184"
};


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
  <div id="driverAge">The graphics driver is `+ driverAge +` days old.</div>
  <div id="Requirements"></div>
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
 * Everything lives under the EJF_SD namespace to avoid polluting globals. Plain var/function +
 * Promises + jQuery, matching the rest of this file. Jira REST calls are same-origin and rely on
 * the browser session cookie (no auth header / no GM_xmlhttpRequest needed), exactly like the
 * existing Translate / Convert-to-Defect calls.
 * ========================================================================================= */
var EJF_SD = {
    HOST: 'https://fenriscreations.atlassian.net',
    SCOPE: 'project in (EDR, EO)',                 // dataset definition (tweak here to change scope)
    EBR_SCOPE: 'project = EBR AND statusCategory != Done',  // open bug reports, for the EDR "matching reports" view
    FIELDS: ['summary', 'description', 'status', 'resolution', 'resolutiondate', 'created', 'components', 'updated', 'project'],
    DB_NAME: 'EJF_SimilarDefects',
    DB_VERSION: 1,
    PAGE_SIZE: 100,
    PAGE_DELAY_MS: 250,                            // polite gap between search pages
    NEAR_LIMIT_DELAY_MS: 3000,                     // back off harder when the rate-limit budget is low
    MAX_RETRIES: 5,
    TOP_N: 8,
    MODEL_VERSION: 'gte-small-v3',                  // embedding model tag; bump to force a full re-embed
                                                    // (v1 = NaN from fp16; v2 = fp32; v3 = boilerplate-stripped text)
    DATA_VERSION: 1                                 // stored-record SCHEMA version. Bump whenever a sync change
                                                    // adds/changes a FIELD on stored records that a plain
                                                    // incremental catch-up can't backfill (it only re-fetches
                                                    // CHANGED issues, so old rows keep the old shape). On load
                                                    // EJF_SD.migrate auto-re-fetches any dataset stamped below
                                                    // this. (v1 = added the `created` field for the row date.)
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
EJF_SD.logsig = {
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
        var sig = (frames.length >= EJF_SD.logsig.MIN_FRAMES)
            ? (msg + '|' + frames.join('>')).toLowerCase()
            : null;
        // Crash-site signature: message + only the INNERMOST CRASH_FRAMES frames (where the exception was
        // actually thrown). Two defects that crash at the SAME place with the SAME message but were reached by
        // a DIFFERENT call path share this even though their full `sig` differs - it drives the looser
        // "possibly related" hint (never an exact cluster). Same null condition as `sig` (needs >= MIN_FRAMES).
        var crashSig = (frames.length >= EJF_SD.logsig.MIN_FRAMES)
            ? (msg + '|' + frames.slice(-EJF_SD.logsig.CRASH_FRAMES).join('>')).toLowerCase()
            : null;
        return { sig: sig, crashSig: crashSig, msg: msg };
    },

    // Build (and cache) the signature index from every stored defect. Every defect exhibiting a signature is
    // appended to that signature's cluster (NOT deduped to the first - the whole point is to group them);
    // a defect can paste several exception dumps, so we fingerprint each block. Resolved defects are kept so
    // a cluster can show "already fixed in EDR-x" / regression. keyToSigs lets a single issue find its
    // cluster(s) cheaply. The (key, sig) pair is deduped so one defect counts once per signature.
    ensure: function () {
        if (EJF_SD.logsig._index && !EJF_SD.logsig._dirty) { return Promise.resolve(EJF_SD.logsig._index); }
        if (EJF_SD.logsig._building) { return EJF_SD.logsig._building; }
        EJF_SD.logsig._building = EJF_SD.db.allDefects().then(function (recs) {
            var sigMap = {}, keyToSigs = {}, crashMap = {}, keyToCrash = {}, nSig = 0;
            for (var i = 0; i < recs.length; i++) {
                if (recs[i].project === 'EBR') { continue; }   // mine exception signatures from DEFECTS only, not bug reports
                var desc = recs[i].description;
                if (!desc || desc.indexOf('EXCEPTION #') === -1) { continue; }
                var key = recs[i].key;
                // One member record per defect, shared (by reference) across whatever clusters it lands in.
                var member = { key: key, status: recs[i].status || '', resolution: recs[i].resolution || null, resolutiondate: recs[i].resolutiondate || null, created: recs[i].created || null };
                var blocks = EJF_SD.logsig._splitBlocks(desc);
                for (var b = 0; b < blocks.length; b++) {
                    var fp = EJF_SD.logsig._fingerprint(blocks[b]);
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
            EJF_SD.logsig._index = { sigMap: sigMap, keyToSigs: keyToSigs, crashMap: crashMap, keyToCrash: keyToCrash };
            EJF_SD.logsig._dirty = false;
            EJF_SD.logsig._building = null;
            var nClusters = 0;
            Object.keys(sigMap).forEach(function (s) { if (sigMap[s].members.length >= 2) { nClusters++; } });
            console.log('[EJF-SD] log signatures: ' + nSig + ' stack signatures (' + nClusters + ' shared across ≥2 defects) mined from ' + recs.length + ' defects');
            return EJF_SD.logsig._index;
        }).catch(function (e) { EJF_SD.logsig._building = null; throw e; });
        return EJF_SD.logsig._building;
    },

    // The canonical (newest, since members are sorted newest-first) defect for a signature - back-compat for
    // the log -> defect matchers, which map a signature to a single defect key.
    canonical: function (sig) {
        var c = EJF_SD.logsig._index && EJF_SD.logsig._index.sigMap[sig];
        return (c && c.members.length) ? c.members[0].key : null;
    },

    // Every OTHER defect that shares a signature with `key` (deduped across all of the key's signatures),
    // each with its status/resolution. Drives the inline "Same exception" section on a defect. [] when none.
    siblingsForKey: function (key) {
        return EJF_SD.logsig.ensure().then(function (idx) {
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
        return EJF_SD.logsig.ensure().then(function (idx) {
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
        return EJF_SD.logsig.ensure().then(function (idx) {
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
        wrap.className = 'ejf-excl-cluster';
        var headRow = document.createElement('div');
        headRow.className = 'ejf-excl-head';
        var cnt = document.createElement('span');
        cnt.className = 'ejf-exc-badge open';
        cnt.textContent = c.members.length;
        headRow.appendChild(cnt);
        var lbl = document.createElement('span');
        lbl.className = 'ejf-excl-label';
        lbl.textContent = c.label || c.sig;
        lbl.title = c.sig;
        headRow.appendChild(lbl);
        var members = document.createElement('div');
        members.className = 'ejf-exc-members';
        members.style.display = 'none';
        c.members.forEach(function (m) { members.appendChild(EJF_SD.logsig._memberRowEl(m)); });
        headRow.addEventListener('click', function () {
            members.style.display = (members.style.display === 'none') ? '' : 'none';
        });
        wrap.appendChild(headRow);
        wrap.appendChild(members);
        return wrap;
    },

    // The standalone "Exception clusters" overview: every signature shared by >=2 defects, newest defect
    // first, each expandable to its members. Reuses the settings-menu overlay chrome (#ejf-menu-overlay / #ejf-menu).
    openClustersView: function () {
        if (EJF_SD.menu && EJF_SD.menu.close) { EJF_SD.menu.close(); }   // close the settings menu if it's open
        EJF_SD.menu._injectCss();
        EJF_SD.logsig._injectClusterCss();
        var $overlay = $('<div id="ejf-menu-overlay"></div>');
        var esc = function (e) { if (e.key === 'Escape') { closeView(); } };
        function closeView() { $overlay.remove(); document.removeEventListener('keydown', esc); }
        $overlay.on('click', function (e) { if (e.target === this) { closeView(); } });   // backdrop click
        var $menu = $('<div id="ejf-menu"></div>').appendTo($overlay);
        var $head = $('<div class="ejf-menu-head"><h2>Exception clusters</h2></div>');
        $('<span class="ejf-menu-x" title="Close (Esc)">×</span>').on('click', closeView).appendTo($head);
        $menu.append($head);
        var $sect = $('<div class="ejf-menu-sect"></div>').appendTo($menu);
        $('<div class="ejf-menu-status">Loading clusters…</div>').appendTo($sect);
        $overlay.appendTo(document.body);
        document.addEventListener('keydown', esc);
        EJF_SD.logsig.clusters().then(function (clusters) {
            if (!document.body.contains($overlay[0])) { return; }   // closed before the build finished
            $sect.empty();
            if (!clusters.length) {
                $('<div class="ejf-menu-status">No exception is shared by 2+ defects yet. (Sync the defect DB first if you haven’t.)</div>').appendTo($sect);
                return;
            }
            $('<div class="ejf-menu-status"></div>')
                .text(clusters.length + ' exception' + (clusters.length === 1 ? '' : 's') + ' shared by 2+ defects · newest first')
                .appendTo($sect);
            clusters.forEach(function (c) { $sect.append(EJF_SD.logsig._clusterRow(c)); });
        }, function () {
            if (!document.body.contains($overlay[0])) { return; }
            $sect.empty();
            $('<div class="ejf-menu-status">Could not build clusters.</div>').appendTo($sect);
        });
    },

    // After the main log parser renders, group rows into EXCEPTION blocks, fingerprint each, and match it to
    // a defect by stack signature. The matched defect is flagged on the block's first (EXCEPTION #) row -
    // amber accent + tooltip + [EDR-x] badge - and counted for the panel, which also lists the rest of that
    // defect's cluster. Async (the index is built from IndexedDB); safe to call right after ParseLogs - it
    // patches the already-rendered rows.
    applyToTable: function () {
        return EJF_SD.logsig.ensure().then(function (idx) {
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
                var marked = tr.getAttribute('data-ejf-sig');
                if (marked) {                                     // already processed in a previous pass
                    if (marked !== '0') {                          // ...re-count anchors for the panel
                        var lk = marked.charAt(0) === '~';        // '~' prefix = loose (crash-site) match
                        tally(lk ? marked.slice(1) : marked, tr, null, lk);
                    }
                    i++;
                    continue;
                }
                if (cellText(tr).indexOf('EXCEPTION #') === -1) { tr.setAttribute('data-ejf-sig', '0'); i++; continue; }
                // Gather the whole exception block: rows until EXCEPTION END (inclusive) or the next EXCEPTION #.
                var blockRows = [tr], blockText = cellText(tr), j = i + 1;
                for (; j < rows.length; j++) {
                    var t2 = cellText(rows[j]);
                    if (t2.indexOf('EXCEPTION #') !== -1) { break; }
                    blockRows.push(rows[j]);
                    blockText += '\n' + t2;
                    if (t2.indexOf('EXCEPTION END') !== -1) { j++; break; }
                }
                var fp = EJF_SD.logsig._fingerprint(blockText);
                var defect = (fp.sig && idx.sigMap[fp.sig]) ? idx.sigMap[fp.sig].members[0].key : null;
                var loose = false;
                if (!defect && fp.crashSig && idx.crashMap[fp.crashSig]) {   // no exact hit -> same-crash-site fallback
                    defect = idx.crashMap[fp.crashSig].members[0].key;
                    loose = true;
                }
                // Mark every block row as scanned; only the anchor (first row) carries the defect key (a '~'
                // prefix flags a loose crash-site match so a re-pass keeps the right styling).
                for (var b = 0; b < blockRows.length; b++) {
                    if (!blockRows[b].getAttribute('data-ejf-sig')) {
                        blockRows[b].setAttribute('data-ejf-sig', (b === 0 && defect) ? ((loose ? '~' : '') + defect) : '0');
                    }
                }
                if (defect) { markAnchor(tr, defect, loose); tally(defect, tr, fp.msg, loose); }
                i = j;
            }
            EJF_SD.logsig.renderPanel(found);
        }).catch(function (e) { console.log('[EJF-SD] log signature apply skipped:', e && e.message || e); });
    },

    // Re-run the log->defect match against the CURRENT (possibly just-synced) signature index. Clears the
    // per-row data-ejf-sig scan cache first so EVERY exception block is re-fingerprinted - otherwise rows
    // marked '0' (no match) on the first pass would never re-match a defect that has since been synced in.
    // No-op when no parsed log is open. Called after a sync completes (EJF_SD.sched.markSynced).
    rematch: function () {
        if (!document.getElementById('tableContent')) { return; }   // no parsed log open
        var rows = document.querySelectorAll('#tableContent tbody tr');
        for (var i = 0; i < rows.length; i++) { rows[i].removeAttribute('data-ejf-sig'); }
        EJF_SD.logsig.applyToTable();
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
        return EJF_SD.logsig.ensure().then(function (idx) {
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
                var fp = EJF_SD.logsig._fingerprint(blockText);
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
        if (EJF_SD.logsig._cssInjected) { return; }
        GM_addStyle('\
#ejf-logmatch-panel { position: fixed; top: 70px; right: 18px; width: 300px; max-height: 70vh; z-index: 9000;\
  background: #1D2125; color: #e6e6e6; border: 1px solid #3a434d; border-radius: 6px; box-shadow: 0 4px 18px rgba(0,0,0,.45);\
  font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; font-size: 12px; display: flex; flex-direction: column; overflow: hidden; }\
#ejf-logmatch-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: #282d33; cursor: move; user-select: none; }\
#ejf-logmatch-panel.ejf-logmatch-dragging { opacity: .92; }\
#ejf-logmatch-title { font-weight: 700; flex: 1; }\
#ejf-logmatch-collapse { cursor: pointer; padding: 0 4px; font-weight: 700; }\
#ejf-logmatch-list { list-style: none; margin: 0; padding: 0; overflow-y: auto; }\
#ejf-logmatch-panel.collapsed #ejf-logmatch-list { display: none; }\
#ejf-logmatch-panel.ejf-logmatch-up { flex-direction: column-reverse; }\
.ejf-logmatch-item { padding: 7px 10px; border-bottom: 1px solid #2c333a; cursor: pointer; }\
.ejf-logmatch-item:hover { background: #22272b; }\
.ejf-logmatch-item a { color: #4c9aff; font-weight: 700; text-decoration: none; }\
.ejf-logmatch-item a:hover { text-decoration: underline; }\
.ejf-logmatch-count { float: right; background: #3a434d; color: #cfd6dd; border-radius: 8px; padding: 0 7px; font-size: 10px; font-weight: 700; }\
.ejf-logmatch-sig { margin-top: 3px; color: #9aa6b2; font-family: "Courier New",monospace; font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\
.ejf-logmatch-flash > td { animation: ejfLogFlash 1.5s ease-out; }\
@keyframes ejfLogFlash { 0%, 25% { background-color: rgba(255,181,71,.6); } 100% { background-color: transparent; } }');
        EJF_SD.logsig._cssInjected = true;
    },

    // Shared styling for cluster member rows + status badges, reused by all three surfaces (the log panel's
    // "+N related" expander, the inline "Same exception" section, and the "Exception clusters" overview).
    _clusterCssInjected: false,
    _injectClusterCss: function () {
        if (EJF_SD.logsig._clusterCssInjected) { return; }
        GM_addStyle('\
.ejf-exc-related-toggle { display: inline-block; margin-top: 5px; color: #9aa6b2; font-size: 11px; cursor: pointer; user-select: none; }\
.ejf-exc-related-toggle:hover { color: #cfd6dd; }\
.ejf-exc-members { list-style: none; margin: 4px 0 0; padding: 4px 0 0 8px; border-left: 2px solid #2c333a; }\
.ejf-exc-member { padding: 3px 0; display: flex; align-items: center; gap: 7px; }\
.ejf-exc-member a { color: #4c9aff; text-decoration: none; font-weight: 700; }\
.ejf-exc-member a:hover { text-decoration: underline; }\
.ejf-exc-badge { font-size: 10px; font-weight: 700; border-radius: 8px; padding: 1px 7px; white-space: nowrap; }\
.ejf-exc-badge.open { background: #3a434d; color: #cfd6dd; }\
.ejf-exc-badge.fixed { background: #1f3d2e; color: #7fdca4; }\
.ejf-exc-badge.warn { background: #5a3a1a; color: #ffb547; }\
.ejf-exc-badge.rel { background: transparent; color: #9aa6b2; border: 1px solid #3a434d; }\
.ejf-excl-cluster { border-bottom: 1px solid #2c333a; padding: 7px 0; }\
.ejf-excl-head { display: flex; align-items: center; gap: 8px; cursor: pointer; }\
.ejf-excl-head:hover .ejf-excl-label { color: #fff; }\
.ejf-excl-label { flex: 1; font-family: "Courier New",monospace; font-size: 11px; color: #cfd6dd; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\
/* Inline "Same exception" section: flow the members side-by-side (wrapping) to save vertical space. */\
#ejf-sd-exccluster .ejf-exc-members { display: flex; flex-wrap: wrap; gap: 5px 14px; }\
#ejf-sd-exccluster .ejf-exc-member { padding: 2px 0; }');
        EJF_SD.logsig._clusterCssInjected = true;
    },

    // A status badge for a cluster member: "Fixed"/<resolution> (green) when resolved, else <status>/"Open".
    _statusBadgeEl: function (member) {
        var resolved = !!(member.resolution || member.resolutiondate);
        var badge = document.createElement('span');
        badge.className = 'ejf-exc-badge ' + (resolved ? 'fixed' : 'open');
        badge.textContent = resolved ? (member.resolution || 'Fixed') : (member.status || 'Open');
        return badge;
    },

    // One cluster-member row: key link + status badge + hover preview card. `extraEl` is an optional trailing
    // element (e.g. a ⚠ regression flag). Returns a raw DOM element so both the (vanilla) log panel and the
    // (jQuery) issue/menu surfaces can use it.
    _memberRowEl: function (member, extraEl) {
        var row = document.createElement('div');
        row.className = 'ejf-exc-member';
        var a = document.createElement('a');
        a.href = '/browse/' + member.key;
        a.target = '_blank';
        a.textContent = member.key;
        a.addEventListener('click', function (ev) { ev.stopPropagation(); });
        row.appendChild(a);
        row.appendChild(EJF_SD.logsig._statusBadgeEl(member));
        if (member.related) {   // crash-site peer (same bug, different call path) - flag it as looser
            var rel = document.createElement('span');
            rel.className = 'ejf-exc-badge rel';
            rel.textContent = '~ similar';
            rel.title = 'Same crash site, reached via a different call path — possibly related';
            row.appendChild(rel);
        }
        if (extraEl) { row.appendChild(extraEl); }
        row.addEventListener('mouseenter', function () { EJF_SD.logsig._showDefectTip(member.key, row); });
        row.addEventListener('mouseleave', function () {
            EJF_SD.logsig._hoverKey = null;
            if (EJF_SD.ui && EJF_SD.ui._hideTip) { EJF_SD.ui._hideTip(); }
        });
        return row;
    },

    // Remove the panel once the log viewer is gone (closed / navigated away). Called from the global observer.
    updateVisibility: function () {
        var panel = document.getElementById('ejf-logmatch-panel');
        if (panel && !document.getElementById('tableContent')) { panel.parentNode.removeChild(panel); }
    },

    renderPanel: function (found) {
        var keys = Object.keys(found || {});
        var existing = document.getElementById('ejf-logmatch-panel');
        if (!keys.length) { if (existing) { existing.parentNode.removeChild(existing); } return; }
        EJF_SD.logsig._injectCss();

        // Most-frequent first, then by key for a stable order.
        keys.sort(function (a, b) { return found[b].count - found[a].count || (a < b ? -1 : 1); });

        var panel = existing;
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'ejf-logmatch-panel';
            document.body.appendChild(panel);
        }
        panel.innerHTML = '';
        EJF_SD.logsig._panelIdx = {};

        var collapsed = false;
        try { if (typeof GM_getValue === 'function') { collapsed = !!GM_getValue(EJF_SD.logsig.COLLAPSE_KEY, false); } } catch (e) { collapsed = false; }
        panel.className = collapsed ? 'collapsed' : '';

        var head = document.createElement('div');
        head.id = 'ejf-logmatch-head';
        var title = document.createElement('span');
        title.id = 'ejf-logmatch-title';
        title.textContent = 'Defects in log · ' + keys.length;
        head.appendChild(title);
        var collapse = document.createElement('span');
        collapse.id = 'ejf-logmatch-collapse';
        collapse.title = 'Collapse / expand';
        collapse.textContent = collapsed ? '+' : '–';
        head.appendChild(collapse);
        panel.appendChild(head);

        var listEl = document.createElement('ul');
        listEl.id = 'ejf-logmatch-list';
        panel.appendChild(listEl);

        keys.forEach(function (key) {
            var entry = found[key];
            var li = document.createElement('li');
            li.className = 'ejf-logmatch-item';
            li.title = 'Click to scroll to an occurrence of ' + key + (entry.rows.length > 1 ? ' (click again for the next)' : '');

            // The "main" row content (key + count + signature). The hover preview for THIS defect is bound to
            // this wrapper - NOT the whole <li> - so moving the mouse off a cluster member row back up here
            // re-fires mouseenter and re-shows the main defect's preview (a <li> mouseenter would not, since
            // the pointer never actually left the <li>).
            var mainEl = document.createElement('div');
            mainEl.className = 'ejf-logmatch-main';

            var a = document.createElement('a');
            a.href = '/browse/' + key;
            a.target = '_blank';
            a.textContent = key;
            a.addEventListener('click', function (ev) { ev.stopPropagation(); });   // open the defect, don't scroll
            mainEl.appendChild(a);

            var badge = document.createElement('span');
            badge.className = 'ejf-logmatch-count';
            badge.textContent = entry.count + '×';
            mainEl.appendChild(badge);

            if (entry.loose) {   // matched only by crash site (no exact stack match) - flag it as looser
                var lt = document.createElement('span');
                lt.className = 'ejf-logmatch-count';   // reuse the pill, but muted + transparent
                lt.style.background = 'transparent';
                lt.style.color = '#9aa6b2';
                lt.style.marginRight = '6px';
                lt.textContent = '~ similar';
                lt.title = 'Same crash site, reached via a different call path — possibly related';
                mainEl.appendChild(lt);
            }

            if (entry.raw) {
                var sig = document.createElement('div');
                sig.className = 'ejf-logmatch-sig';
                sig.textContent = entry.raw;
                mainEl.appendChild(sig);
            }

            // Hover preview: show what the defect is about (same styled card as the Similar Defects panel).
            mainEl.addEventListener('mouseenter', function () { EJF_SD.logsig._showDefectTip(key, mainEl); });
            mainEl.addEventListener('mouseleave', function () {
                EJF_SD.logsig._hoverKey = null;
                if (EJF_SD.ui && EJF_SD.ui._hideTip) { EJF_SD.ui._hideTip(); }
            });
            li.appendChild(mainEl);

            // The rest of this defect's cluster - every OTHER defect that reported the same exception - behind
            // a "+N related" expander, so a known logged exception shows all its variants, not just one.
            if (entry.cluster && entry.cluster.length) {
                EJF_SD.logsig._injectClusterCss();
                var members = document.createElement('div');
                members.className = 'ejf-exc-members';
                members.style.display = 'none';
                entry.cluster.forEach(function (m) { members.appendChild(EJF_SD.logsig._memberRowEl(m)); });
                var toggle = document.createElement('div');
                toggle.className = 'ejf-exc-related-toggle';
                toggle.textContent = '+' + entry.cluster.length + ' related ▸';
                toggle.addEventListener('click', function (ev) {
                    ev.stopPropagation();   // don't trigger the row's scroll-to-occurrence
                    var open = members.style.display === 'none';
                    members.style.display = open ? '' : 'none';
                    toggle.textContent = '+' + entry.cluster.length + ' related ' + (open ? '▾' : '▸');
                    EJF_SD.logsig._fitVertical(panel);
                });
                li.appendChild(toggle);
                li.appendChild(members);
            }

            li.addEventListener('click', function () {
                var rowsArr = entry.rows;
                if (!rowsArr.length) { return; }
                var i = EJF_SD.logsig._panelIdx[key] || 0;
                if (i >= rowsArr.length) { i = 0; }              // wrap around
                EJF_SD.logsig._panelIdx[key] = i + 1;
                var target = rowsArr[i];
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                target.classList.add('ejf-logmatch-flash');
                setTimeout(function () { target.classList.remove('ejf-logmatch-flash'); }, 1500);
            });

            listEl.appendChild(li);
        });

        collapse.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var isCollapsed = panel.classList.toggle('collapsed');
            collapse.textContent = isCollapsed ? '+' : '–';
            try { if (typeof GM_setValue === 'function') { GM_setValue(EJF_SD.logsig.COLLAPSE_KEY, isCollapsed); } } catch (e) { /* ignore */ }
            EJF_SD.logsig._fitVertical(panel);   // on expand, grow upward if there's no room below
        });

        EJF_SD.logsig._applyPos(panel);
        EJF_SD.logsig._makeDraggable(panel, head, collapse);
    },

    // Hover preview for a panel entry: look up the defect in the local DB and show the SAME styled card the
    // Similar Defects panel uses (key + summary + status/resolution + description), so you can tell what a
    // logged defect is about without leaving the log. Cached per defect; guarded by _hoverKey so a slow DB
    // read can't pop a tip after the mouse has already left the row.
    _defCache: {},
    _hoverKey: null,
    _showDefectTip: function (key, anchor) {
        if (!EJF_SD.ui || !EJF_SD.ui._showTip) { return; }
        EJF_SD.logsig._hoverKey = key;
        var show = function (rec) {
            if (EJF_SD.logsig._hoverKey !== key) { return; }   // mouse already left before the read returned
            rec = rec || { key: key };
            var meta = rec.status || '';
            if (rec.resolution) { meta += (meta ? ' · ' : '') + rec.resolution; }
            EJF_SD.ui._showTip({ key: rec.key || key, summary: rec.summary, description: rec.description }, anchor, meta);
        };
        if (Object.prototype.hasOwnProperty.call(EJF_SD.logsig._defCache, key)) { show(EJF_SD.logsig._defCache[key]); return; }
        EJF_SD.db.getDefect(key).then(function (rec) {
            EJF_SD.logsig._defCache[key] = rec || null;
            show(rec);
        }, function () { show(null); });
    },

    // Restore a saved {left, top}, clamped on-screen (same approach as the Similar Defects panel).
    _applyPos: function (panel) {
        var pos = null;
        try { if (typeof GM_getValue === 'function') { pos = GM_getValue(EJF_SD.logsig.POS_KEY, null); } } catch (e) { pos = null; }
        if (!pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') { return; }
        var w = panel.offsetWidth || 300, h = panel.offsetHeight || 60;
        var left = Math.min(Math.max(0, pos.left), Math.max(0, window.innerWidth - w));
        var top = Math.min(Math.max(0, pos.top), Math.max(0, window.innerHeight - h));
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel._ejfTop = top;              // remember the intended top so _fitVertical can re-anchor on expand
        EJF_SD.logsig._fitVertical(panel);
    },

    // Keep the (expanded) panel on-screen vertically (same "drop-up" approach as the Similar Defects panel):
    // when positioned by a dragged/saved top and the expanded panel would run off the bottom, pin it by the
    // bottom and reverse the column so the title bar stays put and the list grows UPWARD above it. Only acts
    // when we manage the position via top (dragged / restored), not in the default placement.
    _fitVertical: function (panel) {
        if (!panel) { return; }
        if (typeof panel._ejfTop !== 'number') { return; }
        if (panel.classList.contains('collapsed')) {
            panel.classList.remove('ejf-logmatch-up');
            panel.style.maxHeight = '';
            panel.style.bottom = 'auto';
            panel.style.top = panel._ejfTop + 'px';
            return;
        }
        var margin = 8, vh = window.innerHeight;
        panel.classList.remove('ejf-logmatch-up');
        panel.style.maxHeight = '';
        panel.style.bottom = 'auto';
        panel.style.top = panel._ejfTop + 'px';
        var headEl = document.getElementById('ejf-logmatch-head');
        var headerH = headEl ? headEl.offsetHeight : 34;
        var fullH = panel.offsetHeight;
        if (panel._ejfTop + fullH <= vh - margin) { return; }   // fits growing down -> keep normal layout
        var headerBottom = panel._ejfTop + headerH;
        panel.style.top = 'auto';
        panel.style.bottom = (vh - headerBottom) + 'px';
        panel.style.maxHeight = Math.max(80, Math.min(Math.round(vh * 0.70), headerBottom - margin)) + 'px';
        panel.classList.add('ejf-logmatch-up');
    },

    // Drag by the header; persist the dropped position. The collapse control is excluded so it still toggles.
    _makeDraggable: function (panel, head, collapse) {
        var dragging = false, startX = 0, startY = 0, baseLeft = 0, baseTop = 0;
        // We drag by the HEADER's intended top (panel._ejfTop) and let _fitVertical decide, on every move,
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
            panel._ejfTop = top;                 // _fitVertical sets top/bottom from this (anchor or drop-up)
            EJF_SD.logsig._fitVertical(panel);
            e.preventDefault();
        }
        function onUp() {
            if (!dragging) { return; }
            dragging = false;
            panel.classList.remove('ejf-logmatch-dragging');
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('mouseup', onUp, true);
            var rect = panel.getBoundingClientRect();
            var top = (typeof panel._ejfTop === 'number') ? panel._ejfTop : Math.round(rect.top);
            try { if (typeof GM_setValue === 'function') { GM_setValue(EJF_SD.logsig.POS_KEY, { left: Math.round(rect.left), top: top }); } } catch (e) { /* ignore */ }
            EJF_SD.logsig._fitVertical(panel);
        }
        head.addEventListener('mousedown', function (e) {
            if (e.which && e.which !== 1) { return; }            // left button only
            if (collapse && e.target === collapse) { return; }   // let the collapse toggle work
            // Drag relative to the HEADER's current top (works whether we're top-anchored or in drop-up),
            // so the header tracks the cursor and _fitVertical re-evaluates up/down on every move.
            var hTop = head.getBoundingClientRect().top;
            baseLeft = panel.getBoundingClientRect().left; baseTop = hTop;
            panel._ejfTop = hTop;
            startX = e.clientX; startY = e.clientY;
            dragging = true;
            panel.classList.add('ejf-logmatch-dragging');
            document.addEventListener('mousemove', onMove, true);
            document.addEventListener('mouseup', onUp, true);
            e.preventDefault();
        });
    }
};


/* ---- utilities ---- */
EJF_SD.util = {
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

    // True when a defect is effectively resolved/closed. We check BOTH the resolution field (set on any
    // closed issue) and the status name, because the EVE instance uses custom statuses we can't enumerate.
    isResolved: function (status, resolution) {
        if (resolution) { return true; }
        return /closed|done|resolved|rejected|cancel/i.test(status || '');
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


/* ---- storage layer: IndexedDB ---- */
EJF_SD.db = {
    _db: null,

    open: function () {
        if (EJF_SD.db._db) { return Promise.resolve(EJF_SD.db._db); }
        return new Promise(function (resolve, reject) {
            var req = window.indexedDB.open(EJF_SD.DB_NAME, EJF_SD.DB_VERSION);
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
            req.onsuccess = function (e) { EJF_SD.db._db = e.target.result; resolve(EJF_SD.db._db); };
            req.onerror = function (e) { reject(e.target.error); };
        });
    },

    _store: function (name, mode) {
        return EJF_SD.db._db.transaction(name, mode).objectStore(name);
    },

    bulkPut: function (recs) {
        return EJF_SD.db.open().then(function (db) {
            return new Promise(function (resolve, reject) {
                if (!recs.length) { resolve(0); return; }
                var tx = db.transaction('defects', 'readwrite');
                var store = tx.objectStore('defects');
                for (var i = 0; i < recs.length; i++) { store.put(recs[i]); }
                tx.oncomplete = function () { resolve(recs.length); };
                tx.onerror = function (e) { reject(e.target.error); };
            });
        });
    },

    getDefect: function (key) {
        return EJF_SD.db.open().then(function () {
            return new Promise(function (resolve, reject) {
                var r = EJF_SD.db._store('defects', 'readonly').get(key);
                r.onsuccess = function () { resolve(r.result || null); };
                r.onerror = function (e) { reject(e.target.error); };
            });
        });
    },

    allDefects: function () {
        return EJF_SD.db.open().then(function () {
            return new Promise(function (resolve, reject) {
                var r = EJF_SD.db._store('defects', 'readonly').getAll();
                r.onsuccess = function () { resolve(r.result || []); };
                r.onerror = function (e) { reject(e.target.error); };
            });
        });
    },

    countDefects: function () {
        return EJF_SD.db.open().then(function () {
            return new Promise(function (resolve, reject) {
                var r = EJF_SD.db._store('defects', 'readonly').count();
                r.onsuccess = function () { resolve(r.result || 0); };
                r.onerror = function (e) { reject(e.target.error); };
            });
        });
    },

    // Clear the DEFECT records (EDR/EO) only, preserving any stored open bug reports (EBR). Used by the
    // "Rebuild defect database" action, which must not wipe the separately-synced bug-report dataset.
    clearDefects: function () {
        return EJF_SD.db.allDefects().then(function (recs) {
            var keys = [];
            for (var i = 0; i < recs.length; i++) { if (recs[i].project !== 'EBR') { keys.push(recs[i].key); } }
            return EJF_SD.db.deleteDefects(keys);
        });
    },

    // Clear ONLY the stored open bug reports (EBR), preserving the defect records. The mirror of
    // clearDefects, used by the "Rebuild BR DB" action.
    clearEbr: function () {
        return EJF_SD.db.allDefects().then(function (recs) {
            var keys = [];
            for (var i = 0; i < recs.length; i++) { if (recs[i].project === 'EBR') { keys.push(recs[i].key); } }
            return EJF_SD.db.deleteDefects(keys);
        });
    },

    // Delete records by key (used by the EBR incremental sync to drop reports that have since closed).
    deleteDefects: function (keys) {
        return EJF_SD.db.open().then(function (db) {
            return new Promise(function (resolve, reject) {
                if (!keys || !keys.length) { resolve(0); return; }
                var tx = db.transaction('defects', 'readwrite');
                var store = tx.objectStore('defects');
                for (var i = 0; i < keys.length; i++) { store.delete(keys[i]); }
                tx.oncomplete = function () { resolve(keys.length); };
                tx.onerror = function (e) { reject(e.target.error); };
            });
        });
    },

    // Count stored records whose project key === project (e.g. 'EBR'), via the by_project index.
    countByProject: function (project) {
        return EJF_SD.db.open().then(function () {
            return new Promise(function (resolve, reject) {
                var r = EJF_SD.db._store('defects', 'readonly').index('by_project').count(IDBKeyRange.only(project));
                r.onsuccess = function () { resolve(r.result || 0); };
                r.onerror = function (e) { reject(e.target.error); };
            });
        });
    },

    countEbr: function () { return EJF_SD.db.countByProject('EBR'); },

    // Number of DEFECT records (everything that isn't a bug report). Used by the defect-population checks
    // (sync decisions, "no data yet" messages) so the shared store's EBRs don't make the defect side think
    // it already has data.
    countDefectsOnly: function () {
        return EJF_SD.db.countDefects().then(function (total) {
            return EJF_SD.db.countEbr().then(function (ebr) { return total - ebr; });
        });
    },

    getMeta: function (k) {
        return EJF_SD.db.open().then(function () {
            return new Promise(function (resolve, reject) {
                var r = EJF_SD.db._store('meta', 'readonly').get(k);
                r.onsuccess = function () { resolve(r.result ? r.result.v : null); };
                r.onerror = function (e) { reject(e.target.error); };
            });
        });
    },

    setMeta: function (k, v) {
        return EJF_SD.db.open().then(function () {
            return new Promise(function (resolve, reject) {
                var r = EJF_SD.db._store('meta', 'readwrite').put({ k: k, v: v });
                r.onsuccess = function () { resolve(); };
                r.onerror = function (e) { reject(e.target.error); };
            });
        });
    }
};


/* ---- sync engine ---- */
EJF_SD.sync = {
    running: false,

    // POST to a Jira REST endpoint with the session cookie; retries on HTTP 429 honoring Retry-After.
    _apiPost: function (path, body) {
        return new Promise(function (resolve, reject) {
            (function attempt(retries) {
                $.ajax({
                    url: EJF_SD.HOST + path,
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
            })(EJF_SD.MAX_RETRIES);
        });
    },

    approximateCount: function () {
        return EJF_SD.sync._apiPost('/rest/api/3/search/approximate-count', { jql: EJF_SD.SCOPE })
            .then(function (r) { return (r.data && typeof r.data.count === 'number') ? r.data.count : null; })
            .catch(function () { return null; });
    },

    // Map a raw Jira issue (v2 shape) into a stored defect record.
    _mapIssue: function (issue) {
        var f = issue.fields || {};
        var summary = f.summary || '';
        var description = EJF_SD.util.toPlainText(f.description);
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
            embedding: null,
            embeddingModelVersion: null,
            textHash: EJF_SD.util.hash(summary + '\n' + description)
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
            var body = { jql: jql, fields: EJF_SD.FIELDS, maxResults: EJF_SD.PAGE_SIZE };
            if (token) { body.nextPageToken = token; }
            return EJF_SD.sync._apiPost('/rest/api/3/search/jql', body).then(function (r) {
                var data = r.data || {};
                var issues = data.issues || [];
                var recs = [];
                for (var i = 0; i < issues.length; i++) {
                    var rec = EJF_SD.sync._mapIssue(issues[i]);
                    if (rec.updated && rec.updated > maxUpdated) { maxUpdated = rec.updated; }
                    recs.push(rec);
                }
                // Preserve existing embeddings for issues whose TEXT did not change, so an incremental
                // re-fetch (or a metadata-only update) does not throw away work the embed pass already did.
                // (For an initial full sync the DB is empty, so these lookups all return null and are cheap.)
                return Promise.all(recs.map(function (rec) {
                    return EJF_SD.db.getDefect(rec.key).then(function (old) {
                        if (old && old.embedding && old.textHash === rec.textHash) {
                            rec.embedding = old.embedding;
                            rec.embeddingModelVersion = old.embeddingModelVersion;
                        }
                        return rec;
                    });
                })).then(function (merged) {
                    // pruneResolved: split into keep (still open) vs drop (now resolved -> delete from store).
                    if (opts.pruneResolved) {
                        var keep = [], drop = [];
                        for (var k = 0; k < merged.length; k++) {
                            if (EJF_SD.util.isResolved(merged[k].status, merged[k].resolution)) { drop.push(merged[k].key); }
                            else { keep.push(merged[k]); }
                        }
                        return EJF_SD.db.deleteDefects(drop).then(function () { return EJF_SD.db.bulkPut(keep); });
                    }
                    return EJF_SD.db.bulkPut(merged);
                }).then(function () {
                    stored += recs.length;
                    pages++;
                    if (opts.isEbr) {
                        EJF_SD.rank._dirtyEbr = true;      // EBR keyword index depends on EBR records
                        EJF_SD.rank._dirtyEbrVec = true;   // ...and the EBR vector index (new/removed reports)
                    } else {
                        EJF_SD.rank._dirty = true;
                        EJF_SD.rank._dirtyVec = true;
                        if (EJF_SD.logsig) { EJF_SD.logsig._dirty = true; }   // re-mine exception signatures on next log open
                    }
                    var nextToken = data.nextPageToken || null;
                    // Persist progress so a reload mid-sync resumes rather than restarting.
                    return EJF_SD.db.setMeta(resumeKey, (data.isLast || !nextToken) ? null : nextToken)
                        .then(function () { return EJF_SD.db.setMeta(hwKey, maxUpdated); })
                        .then(function () {
                            EJF_SD.ui.setStatus('Syncing… ' + stored + ' issues fetched');
                            if (data.isLast || !nextToken) { return { stored: stored, highWater: maxUpdated }; }
                            if (nextToken === token) { throw new Error('nextPageToken did not advance – stopping (Jira API quirk).'); }
                            token = nextToken;
                            var near = (r.xhr.getResponseHeader('X-RateLimit-NearLimit') === 'true');
                            return EJF_SD.util.delay(near ? EJF_SD.NEAR_LIMIT_DELAY_MS : EJF_SD.PAGE_DELAY_MS).then(nextPage);
                        });
                });
            });
        }
        return nextPage();
    },

    fullSync: function () {
        return EJF_SD.db.getMeta('resumeToken').then(function (rt) {
            return EJF_SD.db.getMeta('lastSyncHighWater').then(function (hw) {
                var jql = EJF_SD.SCOPE + ' ORDER BY updated ASC';
                return EJF_SD.sync._run(jql, { startToken: rt || null, startHighWater: hw || '' }).then(function (res) {
                    // A full crawl re-fetched every defect, so the whole dataset now carries the current field
                    // set - stamp the schema version + build time (read by EJF_SD.migrate to auto-rebuild a
                    // stale DB, and shown in the settings menu so you can see when the DB was built).
                    return EJF_SD.db.setMeta('lastFullSyncAt', new Date().toISOString())
                        .then(function () { return EJF_SD.db.setMeta('modelVersion', EJF_SD.MODEL_VERSION); })
                        .then(function () { return EJF_SD.db.setMeta('dataVersionDefects', EJF_SD.DATA_VERSION); })
                        .then(function () { return EJF_SD.db.setMeta('dbBuiltAtDefects', new Date().toISOString()); })
                        .then(function () { return res; });
                });
            });
        });
    },

    incrementalSync: function () {
        return EJF_SD.db.getMeta('lastSyncHighWater').then(function (hw) {
            if (!hw) { return EJF_SD.sync.fullSync(); }
            var since = EJF_SD.util.toJqlTime(hw);
            if (!since) { return EJF_SD.sync.fullSync(); }
            var jql = EJF_SD.SCOPE + ' AND updated >= "' + since + '" ORDER BY updated ASC';
            return EJF_SD.sync._run(jql, { startHighWater: hw });
        });
    },

    // Menu entry point: full sync if the DB is empty, otherwise an incremental catch-up.
    syncNow: function () {
        if (EJF_SD.sync.running) { EJF_SD.ui.toast('A sync is already running…'); return Promise.resolve(); }
        EJF_SD.sync.running = true;
        EJF_SD.ui.toast('Starting defect sync…');
        EJF_SD.ui.setStatus('Starting sync…');
        return EJF_SD.db.countDefectsOnly().then(function (n) {
            return n === 0 ? EJF_SD.sync.fullSync() : EJF_SD.sync.incrementalSync();
        }).then(function (res) {
            return EJF_SD.db.countDefectsOnly().then(function (total) {
                EJF_SD.sync.running = false;
                EJF_SD.ui.toast('Defect sync complete – ' + total + ' defects in local DB.');
                EJF_SD.ui.setStatus(total + ' defects in database');
                EJF_SD.sched.markSynced();   // a manual sync also resets the auto-sync 30-min clock
                if (EJF_SD.ui.currentKey && /^EBR-/.test(EJF_SD.ui.currentKey)) { EJF_SD.ui.scheduleRender(); }   // defect data only affects the EBR (similar defects) view
                EJF_SD.embed.prepare(true);   // embed new/changed defects in the background (no-op if model unavailable)
                return res;
            });
        }).catch(function (e) {
            EJF_SD.sync.running = false;
            EJF_SD.db.setMeta('lastError', String(e && e.message || e));
            EJF_SD.ui.setStatus('Sync error: ' + (e && e.message || e));
            alert('Defect sync failed: ' + (e && e.message || e) + '\nReport issues to Schogol :).');
        });
    },

    // Wipe the local DB and rebuild from scratch (also used after a model-version change in Phase 2).
    rebuild: function () {
        if (EJF_SD.sync.running) { EJF_SD.ui.toast('A sync is already running…'); return Promise.resolve(); }
        if (!confirm('Rebuild the local defect database from scratch? This re-fetches every EDR/EO issue.')) { return Promise.resolve(); }
        EJF_SD.sync.running = true;
        EJF_SD.ui.toast('Rebuilding defect database…');
        return EJF_SD.db.clearDefects()
            .then(function () { return EJF_SD.db.setMeta('resumeToken', null); })
            .then(function () { return EJF_SD.db.setMeta('lastSyncHighWater', ''); })
            .then(function () { EJF_SD.rank._dirty = true; return EJF_SD.sync.fullSync(); })
            .then(function () {
                return EJF_SD.db.countByProject('EBR').then(function (ebr) {
                  return EJF_SD.db.countDefects().then(function (total) {
                    EJF_SD.sync.running = false;
                    EJF_SD.ui.toast('Rebuild complete – ' + (total - ebr) + ' defects.');   // EBRs are preserved, exclude them from the count
                    EJF_SD.sched.markSynced();   // a rebuild also resets the auto-sync 30-min clock
                    if (EJF_SD.ui.currentKey && /^EBR-/.test(EJF_SD.ui.currentKey)) { EJF_SD.ui.scheduleRender(); }   // defect data only affects the EBR (similar defects) view
                    EJF_SD.embed.prepare(true);   // re-embed everything in the background
                  });
                });
            })
            .catch(function (e) {
                EJF_SD.sync.running = false;
                EJF_SD.ui.setStatus('Rebuild error: ' + (e && e.message || e));
                alert('Rebuild failed: ' + (e && e.message || e));
            });
    },

    // Wipe ONLY the stored open bug reports and rebuild that dataset from scratch (defects are preserved).
    // The mirror of rebuild() for the EBR side: clear EBR records + their cursors, then a full EBR build.
    // Useful when the open-report set has drifted (closures missed between incremental syncs) and you want
    // a clean re-fetch, since "Sync bug reports now" only ever does an incremental catch-up once populated.
    rebuildEbr: function () {
        if (EJF_SD.sync.running) { EJF_SD.ui.toast('A sync is already running…'); return Promise.resolve(); }
        if (!confirm('Rebuild the local bug report database from scratch? This re-fetches every open EBR.')) { return Promise.resolve(); }
        EJF_SD.sync.running = true;
        EJF_SD.ui.toast('Rebuilding bug report database…');
        return EJF_SD.db.clearEbr()
            .then(function () { return EJF_SD.db.setMeta('resumeTokenEbr', null); })
            .then(function () { return EJF_SD.db.setMeta('lastSyncHighWaterEbr', ''); })
            .then(function () { EJF_SD.rank._dirtyEbr = true; EJF_SD.rank._dirtyEbrVec = true; return EJF_SD.sync.fullSyncEbr(); })
            .then(function () {
                return EJF_SD.db.countEbr().then(function (total) {
                    EJF_SD.sync.running = false;
                    EJF_SD.ui.toast('Rebuild complete – ' + total + ' open bug reports.');
                    EJF_SD.sched.markSynced();   // a rebuild also resets the auto-sync 30-min clock
                    if (EJF_SD.ui.currentKey && EJF_SD.ui._isDefectKey(EJF_SD.ui.currentKey)) { EJF_SD.ui.scheduleRender(); }   // bug-report data only affects the EDR/EO (matching reports) view
                    EJF_SD.embed.prepare(true);   // re-embed the bug reports in the background
                });
            })
            .catch(function (e) {
                EJF_SD.sync.running = false;
                EJF_SD.ui.setStatus('Bug report rebuild error: ' + (e && e.message || e));
                alert('Bug report rebuild failed: ' + (e && e.message || e));
            });
    },

    // Re-crawl a whole dataset from scratch WITHOUT clearing it first (unlike rebuild). Resetting the cursors
    // forces a full crawl; because the existing records stay put, _run's "preserve embedding when textHash is
    // unchanged" path keeps every vector while bulkPut overwrites each record with the current field set - so
    // a newly-added field (e.g. `created`) is backfilled with NO re-embedding. Used by EJF_SD.migrate to
    // upgrade a DB built before a field existed. Single-flight via `running`; quiet (no confirm dialog).
    refetchDefects: function () {
        if (EJF_SD.sync.running) { return Promise.resolve(); }
        EJF_SD.sync.running = true;
        EJF_SD.ui.toast('Updating local defect database to the latest format…');
        return EJF_SD.db.setMeta('resumeToken', null)
            .then(function () { return EJF_SD.db.setMeta('lastSyncHighWater', ''); })
            .then(function () { EJF_SD.rank._dirty = true; EJF_SD.rank._dirtyVec = true; return EJF_SD.sync.fullSync(); })
            .then(function () {
                return EJF_SD.db.countDefectsOnly().then(function (total) {
                    EJF_SD.sync.running = false;
                    EJF_SD.ui.toast('Defect database updated – ' + total + ' defects.');
                    EJF_SD.sched.markSynced();
                    if (EJF_SD.ui.currentKey && /^EBR-/.test(EJF_SD.ui.currentKey)) { EJF_SD.ui.scheduleRender(); }
                    EJF_SD.embed.prepare(true);
                });
            })
            .catch(function (e) {
                EJF_SD.sync.running = false;
                console.log('[EJF-SD] defect refetch (migration) failed:', e && e.message || e);
            });
    },

    refetchEbr: function () {
        if (EJF_SD.sync.running) { return Promise.resolve(); }
        EJF_SD.sync.running = true;
        EJF_SD.ui.toast('Updating local bug report database to the latest format…');
        return EJF_SD.db.setMeta('resumeTokenEbr', null)
            .then(function () { return EJF_SD.db.setMeta('lastSyncHighWaterEbr', ''); })
            .then(function () { EJF_SD.rank._dirtyEbr = true; EJF_SD.rank._dirtyEbrVec = true; return EJF_SD.sync.fullSyncEbr(); })
            .then(function () {
                return EJF_SD.db.countEbr().then(function (total) {
                    EJF_SD.sync.running = false;
                    EJF_SD.ui.toast('Bug report database updated – ' + total + ' open reports.');
                    EJF_SD.sched.markSynced();
                    if (EJF_SD.ui.currentKey && EJF_SD.ui._isDefectKey(EJF_SD.ui.currentKey)) { EJF_SD.ui.scheduleRender(); }
                    EJF_SD.embed.prepare(true);
                });
            })
            .catch(function (e) {
                EJF_SD.sync.running = false;
                console.log('[EJF-SD] bug report refetch (migration) failed:', e && e.message || e);
            });
    },

    // ---- open bug reports (EBR) sync, for the EDR "matching reports" view ----
    // Same paging engine as the defects, but its own meta cursors (resumeTokenEbr / lastSyncHighWaterEbr)
    // and the EBR keyword index as the dirty target. The FULL build uses the open-only scope; the
    // INCREMENTAL pass drops the open-filter and prunes (deletes) reports that have since closed.
    fullSyncEbr: function () {
        return EJF_SD.db.getMeta('resumeTokenEbr').then(function (rt) {
            return EJF_SD.db.getMeta('lastSyncHighWaterEbr').then(function (hw) {
                var jql = EJF_SD.EBR_SCOPE + ' ORDER BY updated ASC';
                return EJF_SD.sync._run(jql, { startToken: rt || null, startHighWater: hw || '', metaPrefix: 'Ebr', isEbr: true }).then(function (res) {
                    // Full open-EBR crawl -> stamp the EBR schema version + build time (see fullSync / EJF_SD.migrate).
                    return EJF_SD.db.setMeta('dataVersionEbr', EJF_SD.DATA_VERSION)
                        .then(function () { return EJF_SD.db.setMeta('dbBuiltAtEbr', new Date().toISOString()); })
                        .then(function () { return res; });
                });
            });
        });
    },

    incrementalSyncEbr: function () {
        return EJF_SD.db.getMeta('lastSyncHighWaterEbr').then(function (hw) {
            if (!hw) { return EJF_SD.sync.fullSyncEbr(); }
            var since = EJF_SD.util.toJqlTime(hw);
            if (!since) { return EJF_SD.sync.fullSyncEbr(); }
            // No open-filter here on purpose: we want updated-but-now-closed reports back so pruneResolved
            // can delete them from the open-report set.
            var jql = 'project = EBR AND updated >= "' + since + '" ORDER BY updated ASC';
            return EJF_SD.sync._run(jql, { startHighWater: hw, metaPrefix: 'Ebr', pruneResolved: true, isEbr: true });
        });
    },

    // Menu entry point for the bug-report dataset: full build if empty, otherwise an incremental catch-up.
    syncEbrNow: function () {
        if (EJF_SD.sync.running) { EJF_SD.ui.toast('A sync is already running…'); return Promise.resolve(); }
        EJF_SD.sync.running = true;
        EJF_SD.ui.toast('Starting bug report sync…');
        EJF_SD.ui.setStatus('Starting bug report sync…');
        return EJF_SD.db.countEbr().then(function (n) {
            return n === 0 ? EJF_SD.sync.fullSyncEbr() : EJF_SD.sync.incrementalSyncEbr();
        }).then(function () {
            return EJF_SD.db.countEbr().then(function (total) {
                EJF_SD.sync.running = false;
                EJF_SD.rank._dirtyEbr = true;
                EJF_SD.rank._dirtyEbrVec = true;
                EJF_SD.ui.toast('Bug report sync complete – ' + total + ' open reports in local DB.');
                EJF_SD.sched.markSynced();   // a manual sync also resets the auto-sync 30-min clock
                if (EJF_SD.ui.currentKey && EJF_SD.ui._isDefectKey(EJF_SD.ui.currentKey)) { EJF_SD.ui.scheduleRender(); }
                EJF_SD.embed.prepare(true);   // embed the new/changed bug reports in the background (for hybrid)
            });
        }).catch(function (e) {
            EJF_SD.sync.running = false;
            EJF_SD.db.setMeta('lastError', String(e && e.message || e));
            EJF_SD.ui.setStatus('Bug report sync error: ' + (e && e.message || e));
            alert('Bug report sync failed: ' + (e && e.message || e) + '\nReport issues to Schogol :).');
        });
    },

    // Quiet background catch-up used by the auto-sync scheduler. BOTH datasets AUTO-INITIALIZE on the first
    // run (full build when the DB is empty) and then run incremental catch-ups: DEFECTS (EDR/EO) and OPEN
    // BUG REPORTS (EBRs). No start/finish toasts; re-embeds / refreshes the open panel only on actual changes.
    autoSync: function () {
        if (EJF_SD.sync.running) { return Promise.resolve(); }
        EJF_SD.sync.running = true;
        var defectStored = 0, ebrChanged = false;
        return EJF_SD.db.countDefectsOnly().then(function (n) {
            // Auto-initialize the defect DB on the first run (full build), then incremental catch-up.
            var run = (n === 0) ? EJF_SD.sync.fullSync() : EJF_SD.sync.incrementalSync();
            return run.then(function (res) { defectStored = (res && res.stored) || 0; });
        }).then(function () {
            return EJF_SD.db.countEbr().then(function (m) {
                // First run with no reports yet -> initialize the open-report DB once; otherwise catch up.
                var run = (m === 0) ? EJF_SD.sync.fullSyncEbr() : EJF_SD.sync.incrementalSyncEbr();
                return run.then(function (res) { if (m === 0 || (res && res.stored)) { ebrChanged = true; } });
            });
        }).then(function () {
            EJF_SD.sync.running = false;
            console.log('[EJF-SD] auto-sync done (defects ' + defectStored + ' fetched; EBRs ' + (ebrChanged ? 'updated' : 'unchanged') + ')');
            return EJF_SD.db.setMeta('lastAutoSyncAt', new Date().toISOString()).then(function () {
                EJF_SD.sched.markSynced();   // start the 30-min clock so reloads don't re-fetch
                if (defectStored > 0 || ebrChanged) { EJF_SD.embed.prepare(true); }   // embed any new/changed defects AND bug reports
                if (defectStored > 0 && EJF_SD.ui.currentKey && /^EBR-/.test(EJF_SD.ui.currentKey)) { EJF_SD.ui.scheduleRender(); }
                if (ebrChanged && EJF_SD.ui.currentKey && EJF_SD.ui._isDefectKey(EJF_SD.ui.currentKey)) { EJF_SD.ui.scheduleRender(); }
            });
        }).catch(function (e) {
            EJF_SD.sync.running = false;
            EJF_SD.db.setMeta('lastError', String(e && e.message || e));
            console.log('[EJF-SD] auto-sync error:', e && e.message || e);
        });
    }
};


/* ---- ranking: BM25 keyword similarity (Phase 1) ---- */
EJF_SD.rank = {
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
            if (t.length >= 2 && !EJF_SD.rank.STOP[t]) { out.push(t); }
        }
        return out;
    },

    _ensureIndex: function () {
        if (EJF_SD.rank._index && !EJF_SD.rank._dirty) { return Promise.resolve(EJF_SD.rank._index); }
        if (EJF_SD.rank._building) { return EJF_SD.rank._building; }
        EJF_SD.rank._building = EJF_SD.db.allDefects().then(function (records) {
            var df = {}, docs = [], totalLen = 0;
            for (var i = 0; i < records.length; i++) {
                var rec = records[i];
                if (rec.project === 'EBR') { continue; }   // bug reports live in the same store but are ranked separately
                var toks = EJF_SD.rank._tokenize(EJF_SD.util.cleanForCompare(rec.summary, rec.description));
                var tf = {}, seen = {};
                for (var j = 0; j < toks.length; j++) {
                    var tk = toks[j];
                    tf[tk] = (tf[tk] || 0) + 1;
                    if (!seen[tk]) { df[tk] = (df[tk] || 0) + 1; seen[tk] = true; }
                }
                totalLen += toks.length;
                docs.push({ key: rec.key, project: rec.project, summary: rec.summary, status: rec.status, resolution: rec.resolution, resolutiondate: rec.resolutiondate, tf: tf, len: toks.length });
            }
            EJF_SD.rank._index = { N: docs.length, avgdl: docs.length ? (totalLen / docs.length) : 0, df: df, docs: docs };
            EJF_SD.rank._dirty = false;
            EJF_SD.rank._building = null;
            return EJF_SD.rank._index;
        }).catch(function (e) { EJF_SD.rank._building = null; throw e; });
        return EJF_SD.rank._building;
    },

    // Rank stored defects against the query text. Returns up to `limit` (default TOP_N) scored results.
    suggest: function (text, excludeKey, limit) {
        return EJF_SD.rank._ensureIndex().then(function (idx) {
            if (!idx || !idx.N) { return []; }
            var qTokens = EJF_SD.rank._tokenize(text);
            var qSet = {};
            for (var i = 0; i < qTokens.length; i++) { qSet[qTokens[i]] = true; }
            var terms = Object.keys(qSet);
            if (!terms.length) { return []; }
            var k1 = EJF_SD.rank.K1, b = EJF_SD.rank.B, avgdl = idx.avgdl || 1;
            // precompute idf per query term
            var idf = {};
            for (var t = 0; t < terms.length; t++) {
                var n = idx.df[terms[t]] || 0;
                idf[terms[t]] = Math.log(1 + (idx.N - n + 0.5) / (n + 0.5));
            }
            var scored = [];
            for (var d = 0; d < idx.docs.length; d++) {
                var doc = idx.docs[d];
                if (excludeKey && doc.key === excludeKey) { continue; }
                var score = 0;
                for (var q = 0; q < terms.length; q++) {
                    var tf = doc.tf[terms[q]];
                    if (!tf) { continue; }
                    var denom = tf + k1 * (1 - b + b * (doc.len / avgdl));
                    score += idf[terms[q]] * (tf * (k1 + 1)) / denom;
                }
                if (score > 0) { scored.push({ key: doc.key, project: doc.project, summary: doc.summary, status: doc.status, resolution: doc.resolution, resolutiondate: doc.resolutiondate, score: score }); }
            }
            scored.sort(function (a, c) { return c.score - a.score; });
            return scored.slice(0, limit || EJF_SD.TOP_N);
        });
    },

    // Build (and cache) a BM25 index over the OPEN bug reports (project EBR) stored in the same DB. Same
    // shape and tokenizer as the defect index; closed reports are skipped defensively (the EBR sync prunes
    // them, but a stale record could linger between syncs).
    _ensureEbrIndex: function () {
        if (EJF_SD.rank._ebrIndex && !EJF_SD.rank._dirtyEbr) { return Promise.resolve(EJF_SD.rank._ebrIndex); }
        if (EJF_SD.rank._buildingEbr) { return EJF_SD.rank._buildingEbr; }
        EJF_SD.rank._buildingEbr = EJF_SD.db.allDefects().then(function (records) {
            var df = {}, docs = [], totalLen = 0;
            for (var i = 0; i < records.length; i++) {
                var rec = records[i];
                if (rec.project !== 'EBR') { continue; }
                if (EJF_SD.util.isResolved(rec.status, rec.resolution)) { continue; }   // open reports only
                var toks = EJF_SD.rank._tokenize(EJF_SD.util.cleanForCompare(rec.summary, rec.description));
                var tf = {}, seen = {};
                for (var j = 0; j < toks.length; j++) {
                    var tk = toks[j];
                    tf[tk] = (tf[tk] || 0) + 1;
                    if (!seen[tk]) { df[tk] = (df[tk] || 0) + 1; seen[tk] = true; }
                }
                totalLen += toks.length;
                docs.push({ key: rec.key, project: rec.project, summary: rec.summary, status: rec.status, resolution: rec.resolution, resolutiondate: rec.resolutiondate, tf: tf, len: toks.length });
            }
            EJF_SD.rank._ebrIndex = { N: docs.length, avgdl: docs.length ? (totalLen / docs.length) : 0, df: df, docs: docs };
            EJF_SD.rank._dirtyEbr = false;
            EJF_SD.rank._buildingEbr = null;
            return EJF_SD.rank._ebrIndex;
        }).catch(function (e) { EJF_SD.rank._buildingEbr = null; throw e; });
        return EJF_SD.rank._buildingEbr;
    },

    // Rank OPEN bug reports against the query text (a defect's text). Returns up to `limit` scored results,
    // each with a display `pct` relative to the top score. Mirrors `suggest` but over the EBR index.
    suggestEbr: function (text, excludeKey, limit) {
        return EJF_SD.rank._ensureEbrIndex().then(function (idx) {
            if (!idx || !idx.N) { return []; }
            var qTokens = EJF_SD.rank._tokenize(text);
            var qSet = {};
            for (var i = 0; i < qTokens.length; i++) { qSet[qTokens[i]] = true; }
            var terms = Object.keys(qSet);
            if (!terms.length) { return []; }
            var k1 = EJF_SD.rank.K1, b = EJF_SD.rank.B, avgdl = idx.avgdl || 1;
            var idf = {};
            for (var t = 0; t < terms.length; t++) {
                var n = idx.df[terms[t]] || 0;
                idf[terms[t]] = Math.log(1 + (idx.N - n + 0.5) / (n + 0.5));
            }
            var scored = [];
            for (var d = 0; d < idx.docs.length; d++) {
                var doc = idx.docs[d];
                if (excludeKey && doc.key === excludeKey) { continue; }
                var score = 0;
                for (var q = 0; q < terms.length; q++) {
                    var tf = doc.tf[terms[q]];
                    if (!tf) { continue; }
                    var denom = tf + k1 * (1 - b + b * (doc.len / avgdl));
                    score += idf[terms[q]] * (tf * (k1 + 1)) / denom;
                }
                if (score > 0) { scored.push({ key: doc.key, project: doc.project, summary: doc.summary, status: doc.status, resolution: doc.resolution, resolutiondate: doc.resolutiondate, score: score }); }
            }
            scored.sort(function (a, c) { return c.score - a.score; });
            scored = scored.slice(0, limit || EJF_SD.TOP_N);
            var top = (scored[0] && scored[0].score) || 0;
            for (var p = 0; p < scored.length; p++) { scored[p].pct = top > 0 ? Math.round(scored[p].score / top * 100) : 0; }
            return scored;
        });
    }
};


/* ---- embedding engine: local transformers.js (Phase 2) ----
 * Lazily loads a small sentence-embedding model in the browser (no server, no API key) and embeds
 * defect text into 384-dim normalized vectors. CSP on this instance is permissive (only frame-ancestors,
 * WASM OK), so we load the library with a plain dynamic import() of a pinned CDN ESM build and let it
 * fetch model weights directly. Any failure flips `unavailable` and the ranking layer falls back to BM25.
 */
EJF_SD.embed = {
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
        EJF_SD.embed._pipe = null;
        EJF_SD.embed._loading = null;
        EJF_SD.embed.ready = false;
    },

    // Load (once) the transformers.js pipeline. Resolves to the pipeline, or rejects and sets `unavailable`.
    // Inference is kept OFF the main thread so the Jira tab never freezes: WebGPU runs on the GPU, and the
    // WASM fallback runs in its own worker via env.backends.onnx.wasm.proxy. We pick WebGPU if it actually
    // works (validated with a tiny warmup) and otherwise fall back to WASM.
    load: function () {
        if (EJF_SD.embed._pipe) { return Promise.resolve(EJF_SD.embed._pipe); }
        if (EJF_SD.embed.unavailable) { return Promise.reject(new Error('embeddings unavailable')); }
        if (EJF_SD.embed._loading) { return EJF_SD.embed._loading; }
        EJF_SD.embed._loading = (function () {
            return import(EJF_SD.embed.LIB_URL).then(function (mod) {
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
                var forceCpu = EJF_SD.embed._cpuFallback ||
                    (typeof GM_getValue === 'function' && GM_getValue('sdForceCpu', false));
                var tryGpu = !forceCpu &&
                    (typeof GM_getValue !== 'function' || GM_getValue('sdTryWebgpu', true));
                var attempts = tryGpu
                    ? [{ device: 'webgpu', dtype: 'fp32' }, { device: 'wasm', dtype: 'q8' }]
                    : [{ device: 'wasm', dtype: 'q8' }];
                function buildWith(opts) {
                    // Validate with a realistic, longer input rather than a single word. fp16/overflow issues
                    // surface only on real-length text, so a tiny warmup would falsely "pass" and we'd store
                    // NaN vectors. Require a finite, properly-normalized vector (sum of squares ~= 1).
                    return mod.pipeline('feature-extraction', EJF_SD.embed.MODEL, opts).then(function (pipe) {
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
                        EJF_SD.embed.backend = attempts[i].device + '/' + attempts[i].dtype;
                        // fp32 GPU memory ~ batch x sequence-length. With MAX_CHARS at 1500, a large batch can
                        // exhaust VRAM and trigger a device loss (the "BindGroup '...' is invalid" cascade), so
                        // WebGPU uses a conservative 8. CPU/WASM runs one at a time: batched (array) inference
                        // hangs the worker there, while the single-string path (same shape as the warmup) is reliable.
                        EJF_SD.embed.BATCH = (attempts[i].device === 'webgpu') ? 8 : 1;
                        return pipe;
                    }, function () {
                        return tryFrom(i + 1);
                    });
                }
                return tryFrom(0);
            }).then(function (pipe) {
                EJF_SD.embed._pipe = pipe;
                EJF_SD.embed.ready = true;
                console.log('[EJF-SD] embedding model ready (backend: ' + EJF_SD.embed.backend + ')');
                return pipe;
            });
        })().catch(function (e) {
            EJF_SD.embed.unavailable = true;
            EJF_SD.embed._loading = null;
            console.log('[EJF-SD] embedding model unavailable, using keyword ranking. Reason:', e && e.message || e);
            throw e;
        });
        return EJF_SD.embed._loading;
    },

    // Embed a single text -> normalized Float32Array(384).
    embedOne: function (text) {
        return EJF_SD.embed.load().then(function (pipe) {
            var input = (text || ' ').slice(0, EJF_SD.embed.MAX_CHARS) || ' ';
            return pipe(input, { pooling: 'mean', normalize: true }).then(function (out) {
                return new Float32Array(out.data);
            });
        });
    },

    // Embed an array of texts -> array of normalized Float32Array(384).
    embedBatch: function (texts) {
        return EJF_SD.embed.load().then(function (pipe) {
            var inputs = texts.map(function (t) { return (t || ' ').slice(0, EJF_SD.embed.MAX_CHARS) || ' '; });
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
        return EJF_SD.embed.load().then(function () {
            return EJF_SD.db.allDefects();
        }).then(function (recs) {
            var todo = [], curVer = 0;
            for (var i = 0; i < recs.length; i++) {
                // Embed BOTH defects and open bug reports (EBRs): hybrid ranking is used on both the EBR
                // (similar defects) and EDR (matching reports) views. Skip closed EBRs - they're not ranked.
                if (recs[i].project === 'EBR' && EJF_SD.util.isResolved(recs[i].status, recs[i].resolution)) { continue; }
                if (recs[i].embedding && recs[i].embeddingModelVersion === EJF_SD.MODEL_VERSION) { curVer++; }
                else { todo.push(recs[i]); }
            }
            console.log('[EJF-SD] embed pass: ' + todo.length + ' to embed, ' + curVer + ' already at ' +
                EJF_SD.MODEL_VERSION + ' (of ' + recs.length + ' total, backend ' + EJF_SD.embed.backend + ')');
            if (!todo.length) { EJF_SD.ui.setStatus('Embeddings up to date (' + curVer + ')'); return; }
            EJF_SD.ui.toast('Embedding ' + todo.length + ' issues locally…');
            var idx = 0, gpuRetries = 0;
            function nextBatch() {
                if (idx >= todo.length) { console.log('[EJF-SD] embed pass complete (' + todo.length + ' embedded)'); EJF_SD.rank._dirtyVec = true; EJF_SD.rank._dirtyEbrVec = true; return Promise.resolve(); }
                var size = EJF_SD.embed.BATCH;
                var slice = todo.slice(idx, idx + size);
                var texts = slice.map(function (r) { return EJF_SD.util.cleanForCompare(r.summary, r.description); });
                // Watchdog: a WebGPU device loss can HANG the worker so embedBatch never resolves OR rejects,
                // which would silently stall the whole pass. Race it against a timeout so a hung batch is
                // treated as a failure and handled by the catch below (retry on the same backend, then pause).
                var t0 = Date.now();
                var batchVecs = EJF_SD.embed.embedBatch(texts);
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
                        slice[j].embeddingModelVersion = EJF_SD.MODEL_VERSION;
                    }
                    return EJF_SD.db.bulkPut(slice).then(function () {
                        idx += slice.length;   // advance by what we actually embedded
                        EJF_SD.rank._dirtyVec = true;
                        EJF_SD.rank._dirtyEbrVec = true;
                        // Log throughput periodically so we can see the real CPU speed (first item always logs).
                        if (idx <= slice.length || idx % 50 === 0) {
                            console.log('[EJF-SD] embedded ' + idx + '/' + todo.length + ' (' + size + ' in ' + dt + 'ms, ' + EJF_SD.embed.backend + ')');
                        }
                        EJF_SD.ui.setStatus('Embedding… ' + Math.min(idx, todo.length) + '/' + todo.length + ' (' + EJF_SD.embed.backend + ')');
                        return EJF_SD.util.delay(0).then(nextBatch);   // yield to keep the UI responsive
                    });
                }).catch(function (e) {
                    // A batch failed (on WebGPU, usually a device loss). We deliberately do NOT auto-switch to
                    // CPU - the backend is the user's choice via the Tampermonkey menu. idx is NOT advanced, so
                    // no progress is lost: retry a few times on the SAME backend to ride out a transient blip,
                    // and if it keeps failing, pause the pass (it resumes on the next reload / scheduled sync)
                    // and tell the user they can switch backend from the menu.
                    console.log('[EJF-SD] embed batch failed (' + EJF_SD.embed.backend + ', size ' + size + '):', e && e.message || e);
                    EJF_SD.embed._resetPipe();
                    gpuRetries++;
                    if (gpuRetries <= 3) {
                        return EJF_SD.util.delay(1500).then(nextBatch);
                    }
                    EJF_SD.ui.toast('Embedding keeps failing on ' + (EJF_SD.embed.backend || 'GPU') + ' — paused. Reload to retry, or switch backend from the Tampermonkey menu.');
                    throw e;   // give up this pass (progress saved; ranking stays on BM25 meanwhile)
                });
            }
            return nextBatch();
        });
    },

    // Background entry point: load the model and embed anything outstanding, then refresh the panel.
    // Idempotent per session unless `force` is passed (used right after a sync brings in new/changed text).
    prepare: function (force) {
        if (EJF_SD.embed.unavailable) { return Promise.resolve(); }
        if (EJF_SD.embed._preparing) { return EJF_SD.embed._preparing; }
        if (EJF_SD.embed._prepared && !force) { return Promise.resolve(); }
        EJF_SD.embed._preparing = EJF_SD.db.countDefects().then(function (n) {
            if (!n) { return; }   // nothing synced yet (no defects AND no bug reports) - don't download a model
            return EJF_SD.embed.embedPass().then(function () {
                EJF_SD.embed._prepared = true;
                EJF_SD.rank._dirtyVec = true;
                EJF_SD.rank._dirtyEbrVec = true;
                // Refresh whichever view is open (coalesced, so a sync + this embed-pass completion collapse
                // into a single list rebuild instead of thrashing): EBR -> similar defects, EDR -> reports.
                EJF_SD.ui.scheduleRender();
            });
        }).then(function () {
            EJF_SD.embed._preparing = null;
        }).catch(function (e) {
            EJF_SD.embed._preparing = null;
            console.log('[EJF-SD] embed prepare skipped:', e && e.message || e);
        });
        return EJF_SD.embed._preparing;
    }
};


/* ---- semantic ranking (Phase 2): cosine over stored embeddings, with BM25 fallback ---- */
EJF_SD.rank._vecIndex = null;     // cached array of { key, project, summary, status, resolution, vec }
EJF_SD.rank._dirtyVec = true;     // rebuild the in-memory vector cache on next semantic query
EJF_SD.rank._buildingVec = null;

// Build (and cache) the in-memory list of vectors for the current model version.
EJF_SD.rank._ensureVecIndex = function () {
    if (EJF_SD.rank._vecIndex && !EJF_SD.rank._dirtyVec) { return Promise.resolve(EJF_SD.rank._vecIndex); }
    if (EJF_SD.rank._buildingVec) { return EJF_SD.rank._buildingVec; }
    EJF_SD.rank._buildingVec = EJF_SD.db.allDefects().then(function (recs) {
        var docs = [];
        for (var i = 0; i < recs.length; i++) {
            var r = recs[i];
            if (r.project === 'EBR') { continue; }   // bug reports are keyword-ranked only, not part of the defect vector index
            if (r.embedding && r.embeddingModelVersion === EJF_SD.MODEL_VERSION) {
                docs.push({ key: r.key, project: r.project, summary: r.summary, status: r.status, resolution: r.resolution, resolutiondate: r.resolutiondate, vec: r.embedding });
            }
        }
        EJF_SD.rank._vecIndex = docs;
        EJF_SD.rank._dirtyVec = false;
        EJF_SD.rank._buildingVec = null;
        return docs;
    }).catch(function (e) { EJF_SD.rank._buildingVec = null; throw e; });
    return EJF_SD.rank._buildingVec;
};

// Cosine similarity of two normalized vectors == dot product.
EJF_SD.rank._dot = function (a, b) {
    var s = 0, n = Math.min(a.length, b.length);
    for (var i = 0; i < n; i++) { s += a[i] * b[i]; }
    return s;
};

EJF_SD.rank.CAND = 50;     // candidates pulled from each retriever before fusion
EJF_SD.rank.RRF_K = 60;    // Reciprocal-Rank-Fusion constant (standard default)

// Cosine-score every stored vector against the query vector, sorted best-first. Returns [] if none embedded.
EJF_SD.rank._semanticScored = function (qv, excludeKey) {
    return EJF_SD.rank._ensureVecIndex().then(function (docs) {
        var scored = [];
        for (var d = 0; d < docs.length; d++) {
            if (excludeKey && docs[d].key === excludeKey) { continue; }
            var sc = EJF_SD.rank._dot(qv, docs[d].vec);
            if (!isFinite(sc)) { continue; }   // defensively drop any corrupt (NaN/Inf) vector
            scored.push({
                key: docs[d].key, project: docs[d].project, summary: docs[d].summary,
                status: docs[d].status, resolution: docs[d].resolution, resolutiondate: docs[d].resolutiondate,
                score: sc
            });
        }
        scored.sort(function (a, c) { return c.score - a.score; });
        return scored;
    });
};

/* ---- EBR semantic ranking (stage 2): cosine over OPEN bug-report embeddings ---- */
EJF_SD.rank._ebrVecIndex = null;
EJF_SD.rank._dirtyEbrVec = true;
EJF_SD.rank._buildingEbrVec = null;

// In-memory vector list over OPEN bug reports (project EBR) with a current-version embedding. Mirrors
// _ensureVecIndex but keeps only open EBRs (closed ones aren't ranked and lose their slot).
EJF_SD.rank._ensureEbrVecIndex = function () {
    if (EJF_SD.rank._ebrVecIndex && !EJF_SD.rank._dirtyEbrVec) { return Promise.resolve(EJF_SD.rank._ebrVecIndex); }
    if (EJF_SD.rank._buildingEbrVec) { return EJF_SD.rank._buildingEbrVec; }
    EJF_SD.rank._buildingEbrVec = EJF_SD.db.allDefects().then(function (recs) {
        var docs = [];
        for (var i = 0; i < recs.length; i++) {
            var r = recs[i];
            if (r.project !== 'EBR') { continue; }
            if (EJF_SD.util.isResolved(r.status, r.resolution)) { continue; }   // open reports only
            if (r.embedding && r.embeddingModelVersion === EJF_SD.MODEL_VERSION) {
                docs.push({ key: r.key, project: r.project, summary: r.summary, status: r.status, resolution: r.resolution, vec: r.embedding });
            }
        }
        EJF_SD.rank._ebrVecIndex = docs;
        EJF_SD.rank._dirtyEbrVec = false;
        EJF_SD.rank._buildingEbrVec = null;
        return docs;
    }).catch(function (e) { EJF_SD.rank._buildingEbrVec = null; throw e; });
    return EJF_SD.rank._buildingEbrVec;
};

// Cosine-score every stored OPEN-EBR vector against the query vector, sorted best-first. [] if none embedded.
EJF_SD.rank._semanticScoredEbr = function (qv, excludeKey) {
    return EJF_SD.rank._ensureEbrVecIndex().then(function (docs) {
        var scored = [];
        for (var d = 0; d < docs.length; d++) {
            if (excludeKey && docs[d].key === excludeKey) { continue; }
            var sc = EJF_SD.rank._dot(qv, docs[d].vec);
            if (!isFinite(sc)) { continue; }
            scored.push({ key: docs[d].key, project: docs[d].project, summary: docs[d].summary, status: docs[d].status, resolution: docs[d].resolution, score: sc });
        }
        scored.sort(function (a, c) { return c.score - a.score; });
        return scored;
    });
};

// Choose the best available ranking. With the model loaded we do HYBRID retrieval: fuse the semantic
// (cosine) and BM25 keyword candidate lists with Reciprocal Rank Fusion. This is the key recall fix - exact
// shared terms (item/module names, error strings) that embeddings smooth over are caught by BM25, while
// paraphrases are caught by the embeddings, so the "obvious" duplicate surfaces far more reliably.
// Returns { mode: 'Hybrid' | 'Keyword', results: [...] } with a display % already attached to each result.
EJF_SD.rank.suggestBest = function (text, key, brCreated) {
    // Feature A: gently demote a Closed defect that was fixed long before this bug report was filed - it
    // is very unlikely to be the report's real duplicate. Scales whatever score fields the result carries
    // (score / rrf / pct) by the age factor and tags it so the panel can grey it and explain why.
    function demote(r) {
        if (!brCreated || !r.resolutiondate || !EJF_SD.util.isResolved(r.status, r.resolution)) { return; }
        var sf = EJF_SD.util.staleFactor(brCreated, r.resolutiondate);
        if (sf.factor >= 1) { return; }
        if (typeof r.score === 'number') { r.score *= sf.factor; }
        if (typeof r.rrf === 'number') { r.rrf *= sf.factor; }
        if (typeof r.pct === 'number') { r.pct = Math.round(r.pct * sf.factor); }
        r.stale = true;
        // Note: the meta line already shows the status ("Closed"), so don't repeat it here - just the gap.
        r.staleNote = 'fixed ' + EJF_SD.util.humanizeAge(sf.ageDays) + ' before report';
    }
    function keywordOnly() {
        // Pull a wider candidate set so the demotion can re-order before we cut to TOP_N (a stale match
        // shouldn't keep a slot a fresher one deserves).
        return EJF_SD.rank.suggest(text, key, EJF_SD.rank.CAND).then(function (list) {
            for (var d = 0; d < list.length; d++) { demote(list[d]); }
            list.sort(function (a, c) { return c.score - a.score; });
            list = list.slice(0, EJF_SD.TOP_N);
            var top = (list[0] && list[0].score) || 0;
            for (var i = 0; i < list.length; i++) { list[i].pct = top > 0 ? Math.round(list[i].score / top * 100) : 0; }
            return { mode: 'Keyword', results: list };
        });
    }
    // Build the HYBRID (semantic + keyword) result set. Called once the embedding model is ready.
    function hybrid() {
        return EJF_SD.embed.embedOne(text).then(function (qv) {
        return EJF_SD.rank._semanticScored(qv, key).then(function (sem) {
            if (!sem.length) { return keywordOnly(); }   // nothing embedded yet
            return EJF_SD.rank.suggest(text, key, EJF_SD.rank.CAND).then(function (bm) {
                var K = EJF_SD.rank.RRF_K;
                var rrf = {}, meta = {}, cosByKey = {};
                var semTop = sem.slice(0, EJF_SD.rank.CAND);
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
                for (var s = 0; s < out.length; s++) { demote(out[s]); }   // Feature A: age-demote stale closed matches
                // RRF decides WHICH results make the cut (so strong keyword hits aren't lost even when their
                // cosine is middling) - then present those top-N sorted by the displayed similarity % so the
                // panel reads high-to-low, matching what the user sees. (Demotion above lowers both rrf and pct
                // for stale matches, so they fall in the cut AND read lower.)
                out.sort(function (a, c2) { return c2.rrf - a.rrf; });
                var topN = out.slice(0, EJF_SD.TOP_N);
                topN.sort(function (a, c2) { return c2.pct - a.pct; });
                return { mode: 'Hybrid', results: topN };
            });
        });
        }).catch(function () {
            // A query-time embed failed (e.g. a WebGPU device loss while viewing a report). We do NOT
            // auto-switch to CPU - that's the user's choice via the menu. Just drop the (possibly dead)
            // pipeline so the next query rebuilds on the same backend, and show keyword results for now.
            EJF_SD.embed._resetPipe();
            return keywordOnly();
        });
    }

    // Model already loaded -> straight to Hybrid. Permanently unavailable -> Keyword only.
    if (EJF_SD.embed.ready) { return hybrid(); }
    if (EJF_SD.embed.unavailable) { return keywordOnly(); }

    // Not ready yet: start the background warm-up + embed pass, then give the model a brief window to finish
    // loading. If it loads in time (fast when the weights are cached), render Hybrid directly and skip the
    // keyword->hybrid flicker; if it's slow (uncached / first download), show Keyword now and let prepare()'s
    // re-render upgrade us once the model is ready.
    EJF_SD.embed.prepare();
    return new Promise(function (resolve) {
        var settled = false;
        var timer = setTimeout(function () {
            if (settled) { return; }
            settled = true;
            resolve(keywordOnly());
        }, EJF_SD.embed.WARM_WAIT_MS);
        EJF_SD.embed.load().then(function () {
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

// EDR (defect) -> matching OPEN bug reports, best available ranking. Same hybrid (semantic + BM25, fused
// with RRF) approach as suggestBest, but over the EBR indexes and with no stale-demotion (open reports have
// no fix date). Returns { mode: 'Hybrid' | 'Keyword', results: [...] } with a display % per result.
EJF_SD.rank.suggestEbrBest = function (text, key) {
    function keywordOnly() {
        // suggestEbr already attaches a top-relative pct.
        return EJF_SD.rank.suggestEbr(text, key, EJF_SD.TOP_N).then(function (list) {
            return { mode: 'Keyword', results: list };
        });
    }
    function hybrid() {
        return EJF_SD.embed.embedOne(text).then(function (qv) {
        return EJF_SD.rank._semanticScoredEbr(qv, key).then(function (sem) {
            if (!sem.length) { return keywordOnly(); }   // nothing embedded yet
            return EJF_SD.rank.suggestEbr(text, key, EJF_SD.rank.CAND).then(function (bm) {
                var K = EJF_SD.rank.RRF_K;
                var rrf = {}, meta = {}, cosByKey = {};
                var semTop = sem.slice(0, EJF_SD.rank.CAND);
                for (var i = 0; i < semTop.length; i++) { rrf[semTop[i].key] = (rrf[semTop[i].key] || 0) + 1 / (K + i); meta[semTop[i].key] = semTop[i]; }
                for (var j = 0; j < bm.length; j++) { rrf[bm[j].key] = (rrf[bm[j].key] || 0) + 1 / (K + j); if (!meta[bm[j].key]) { meta[bm[j].key] = bm[j]; } }
                for (var c = 0; c < sem.length; c++) { cosByKey[sem[c].key] = sem[c].score; }
                var out = Object.keys(rrf).map(function (k) {
                    var m = meta[k];
                    var hasCos = (cosByKey[k] !== undefined && isFinite(cosByKey[k]));
                    return {
                        key: k, project: m.project, summary: m.summary, status: m.status, resolution: m.resolution,
                        rrf: rrf[k], pct: hasCos ? Math.round(Math.max(0, Math.min(1, cosByKey[k])) * 100) : 0
                    };
                });
                // RRF decides the cut; present sorted by the displayed similarity % (matches suggestBest).
                out.sort(function (a, c2) { return c2.rrf - a.rrf; });
                var topN = out.slice(0, EJF_SD.TOP_N);
                topN.sort(function (a, c2) { return c2.pct - a.pct; });
                return { mode: 'Hybrid', results: topN };
            });
        });
        }).catch(function () {
            EJF_SD.embed._resetPipe();   // drop a possibly-dead pipeline; show keyword results for now
            return keywordOnly();
        });
    }

    if (EJF_SD.embed.ready) { return hybrid(); }
    if (EJF_SD.embed.unavailable) { return keywordOnly(); }
    // Not ready yet: kick off the warm-up + embed pass, then briefly wait for the model (fast when cached).
    EJF_SD.embed.prepare();
    return new Promise(function (resolve) {
        var settled = false;
        var timer = setTimeout(function () { if (settled) { return; } settled = true; resolve(keywordOnly()); }, EJF_SD.embed.WARM_WAIT_MS);
        EJF_SD.embed.load().then(function () {
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


/* ---- issue linking: "mark as duplicate" (Feature B) ---- */
EJF_SD.link = {
    _info: null,   // cached { name, ebrSide } - the link-type name + which side the EBR goes on

    // Resolve the duplicate link type AND the side the bug report must sit on so the EBR reads "duplicates"
    // (not "is duplicated by"). Jira links go outward->inward: the outward issue shows the type's `outward`
    // text. So we find the type where "duplicates" is the outward text (EBR = outward) OR the inward text
    // (then EBR = inward, so it still reads "duplicates"). The EVE instance uses custom link types and we
    // can't assume the standard direction, so this is discovered at runtime, cached in memory + GM. (Cache
    // key is versioned because an earlier build cached only the name and could link the wrong way round.)
    dupInfo: function () {
        if (EJF_SD.link._info) { return Promise.resolve(EJF_SD.link._info); }
        var cached = (typeof GM_getValue === 'function') ? GM_getValue('sdDupLink_v2', null) : null;
        if (cached && cached.name) { EJF_SD.link._info = cached; return Promise.resolve(cached); }
        return new Promise(function (resolve) {
            $.ajax({ url: EJF_SD.HOST + '/rest/api/3/issueLinkType', dataType: 'json' })
                .done(function (d) {
                    var types = (d && d.issueLinkTypes) || [];
                    var info = null;
                    for (var i = 0; i < types.length && !info; i++) {
                        var t = types[i];
                        if (/^duplicates$/i.test(t.outward || '')) { info = { name: t.name, ebrSide: 'outward' }; }
                        else if (/^duplicates$/i.test(t.inward || '')) { info = { name: t.name, ebrSide: 'inward' }; }
                    }
                    if (!info) { info = { name: 'Duplicate', ebrSide: 'outward' }; }   // sensible default
                    EJF_SD.link._info = info;
                    try { if (typeof GM_setValue === 'function') { GM_setValue('sdDupLink_v2', info); } } catch (e) { /* ignore */ }
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
        return EJF_SD.link.dupInfo().then(function (info) {
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
                    url: EJF_SD.HOST + '/rest/api/3/issueLink',
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
    attachDuplicate: function (ebrKey, otherKey, statusName, preferredResolution) {
        return EJF_SD.link.dupInfo().then(function (info) {
            return new Promise(function (resolve, reject) {
                $.ajax({ url: EJF_SD.HOST + '/rest/api/3/issue/' + ebrKey + '/transitions?expand=transitions.fields', dataType: 'json' })
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
                            EJF_SD.link.markDuplicate(ebrKey, otherKey)
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
                        // Linked Issues field on the screen: add the duplicate link inline (single call).
                        var hasLinkField = !!(t.fields && t.fields.issuelinks);
                        if (hasLinkField) { payload.update = { issuelinks: [ EJF_SD.link._dupAddOp(info, otherKey) ] }; }

                        function done2xx() {
                            if (hasLinkField) { resolve({ attached: true, linked: true }); return; }
                            // Screen didn't carry the link field -> transition done, now link separately.
                            EJF_SD.link.markDuplicate(ebrKey, otherKey)
                                .then(function () { resolve({ attached: true, linked: true }); },
                                      function () { resolve({ attached: true, linked: false }); });
                        }
                        $.ajax({
                            url: EJF_SD.HOST + '/rest/api/3/issue/' + ebrKey + '/transitions',
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
EJF_SD.ui = {
    currentKey: null,
    _toastTimer: null,

    css: '\
#ejf-sd-panel { position: fixed; right: 18px; bottom: 18px; width: 340px; max-height: 52vh; z-index: 9000;\
  background: #1D2125; color: #e6e6e6; border: 1px solid #3a434d; border-radius: 6px; box-shadow: 0 4px 18px rgba(0,0,0,.45);\
  font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; font-size: 12px; display: flex; flex-direction: column; overflow: hidden; }\
#ejf-sd-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: #282d33; cursor: move; user-select: none; }\
#ejf-sd-panel.ejf-sd-dragging { opacity: .92; }\
#ejf-sd-title { font-weight: 700; flex: 1; }\
#ejf-sd-mode { font-size: 10px; background: #3a434d; padding: 1px 6px; border-radius: 8px; }\
#ejf-sd-collapse { cursor: pointer; padding: 0 4px; font-weight: 700; }\
#ejf-sd-status { padding: 6px 10px; color: #aab3bd; border-bottom: 1px solid #2c333a; }\
#ejf-sd-list { list-style: none; margin: 0; padding: 0; overflow-y: auto; }\
#ejf-sd-list li { padding: 7px 10px; border-bottom: 1px solid #2c333a; }\
#ejf-sd-list a { color: #4c9aff; font-weight: 700; text-decoration: none; }\
#ejf-sd-list a:hover { text-decoration: underline; }\
.ejf-sd-proj { font-size: 10px; background: #3a434d; padding: 0 5px; border-radius: 7px; margin-left: 6px; }\
.ejf-sd-score { float: right; color: #7a8694; font-size: 10px; }\
.ejf-sd-link { float: right; margin-right: 8px; font-size: 10px; color: #9fb4cc; cursor: pointer; user-select: none; }\
.ejf-sd-link:hover { color: #4c9aff; text-decoration: underline; }\
.ejf-sd-link.ejf-sd-linking { color: #7a8694; cursor: default; text-decoration: none; }\
.ejf-sd-link.ejf-sd-linked { color: #4caf7d; cursor: default; text-decoration: none; }\
.ejf-sd-list li.ejf-sd-stale { opacity: .6; }\
.ejf-sd-sum { margin-top: 2px; color: #e6e6e6; }\
.ejf-sd-meta { margin-top: 2px; color: #7a8694; font-size: 10px; }\
.ejf-sd-date { margin-top: 2px; color: #7a8694; font-size: 10px; text-align: right; }\
#ejf-sd-loglink { display: none; padding: 6px 10px; border-bottom: 1px solid #2c333a; background: #20262b; }\
#ejf-sd-loglink.has-hits { display: block; }\
#ejf-sd-loglink .ejf-sd-loglink-head { font-weight: 700; color: #ffb547; font-size: 11px; margin-bottom: 4px; }\
#ejf-sd-loglink ul { list-style: none; margin: 0; padding: 0; }\
#ejf-sd-loglink li { padding: 3px 0; cursor: default; }\
#ejf-sd-loglink a { color: #4c9aff; font-weight: 700; text-decoration: none; }\
#ejf-sd-loglink a:hover { text-decoration: underline; }\
#ejf-sd-loglink .count { color: #cfd6dd; background: #3a434d; border-radius: 8px; padding: 0 7px; font-size: 10px; font-weight: 700; margin-left: 6px; }\
.ejf-sd-loose { font-size: 10px; color: #9aa6b2; margin-left: 6px; }\
#ejf-sd-exccluster { display: none; padding: 6px 10px; border-bottom: 1px solid #2c333a; background: #20262b; }\
#ejf-sd-exccluster.has-hits { display: block; }\
#ejf-sd-exccluster .ejf-sd-exccluster-head { font-weight: 700; color: #cfd6dd; font-size: 11px; margin-bottom: 4px; }\
#ejf-sd-panel.collapsed #ejf-sd-status, #ejf-sd-panel.collapsed #ejf-sd-loglink, #ejf-sd-panel.collapsed #ejf-sd-exccluster, #ejf-sd-panel.collapsed #ejf-sd-list { display: none; }\
#ejf-sd-panel.ejf-sd-up { flex-direction: column-reverse; }\
#ejf-sd-toast { position: fixed; right: 18px; bottom: 18px; z-index: 9001; background: #333; color: #eee; padding: 8px 14px;\
  border-radius: 6px; box-shadow: 0 4px 18px rgba(0,0,0,.45); font-family: -apple-system,Arial,sans-serif; font-size: 12px; max-width: 320px; }\
#ejf-sd-tip { position: fixed; z-index: 10001; display: none; width: 420px; max-height: 60vh; overflow-y: auto;\
  background: #14181b; color: #e6e6e6; border: 1px solid #3a434d; border-radius: 6px; box-shadow: 0 6px 24px rgba(0,0,0,.55);\
  padding: 10px 12px; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; font-size: 12px; line-height: 1.45; pointer-events: none; }\
#ejf-sd-tip .ejf-sd-tip-title { font-weight: 700; color: #fff; margin-bottom: 4px; }\
#ejf-sd-tip .ejf-sd-tip-meta { color: #9fb4cc; font-size: 10px; margin-bottom: 6px; }\
#ejf-sd-tip .ejf-sd-tip-desc { color: #cfd6dd; white-space: pre-wrap; word-break: break-word; }\
#ejf-sd-tip .ejf-sd-tip-dim { color: #7a8694; font-style: italic; }\
#ejf-sd-tip .ejf-sd-tip-media { color: #9fb4cc; font-style: italic; padding: 6px 0; }\
#ejf-sd-tip .ejf-sd-tip-html { white-space: normal; }\
#ejf-sd-tip .ejf-sd-tip-html p { margin: 0 0 8px; }\
#ejf-sd-tip .ejf-sd-tip-html p:last-child { margin-bottom: 0; }\
#ejf-sd-tip .ejf-sd-tip-html ul, #ejf-sd-tip .ejf-sd-tip-html ol { margin: 4px 0; padding-left: 18px; }\
#ejf-sd-tip .ejf-sd-tip-html h1, #ejf-sd-tip .ejf-sd-tip-html h2, #ejf-sd-tip .ejf-sd-tip-html h3, #ejf-sd-tip .ejf-sd-tip-html h4 { font-size: 12px; font-weight: 700; color: #fff; margin: 8px 0 4px; }\
#ejf-sd-tip .ejf-sd-tip-html pre { white-space: pre-wrap; word-break: break-word; background: #0f1316; border: 1px solid #2c333a; border-radius: 4px; padding: 6px 8px; margin: 6px 0; font-family: "Courier New",monospace; font-size: 11px; }\
#ejf-sd-tip .ejf-sd-tip-html code { font-family: "Courier New",monospace; }\
#ejf-sd-tip .ejf-sd-tip-html img { max-width: 100%; height: auto; }\
#ejf-sd-tip .ejf-sd-tip-html a { color: #4c9aff; }\
#ejf-sd-tip .ejf-sd-tip-html table { border-collapse: collapse; margin: 6px 0; }\
#ejf-sd-tip .ejf-sd-tip-html th, #ejf-sd-tip .ejf-sd-tip-html td { border: 1px solid #2c333a; padding: 2px 6px; }\
/* ---- integrated "Triage Assistant" context group (sidebar mode) ---- */\
/* Styled with Atlassian design tokens so it blends into the native panel in both light + dark themes. */\
/* Native-clone path (default): the cloned Details group already supplies the card / header / title font, so\
   we only need to hide its body and rotate its chevron on collapse. */\
#ejf-side-group.collapsed [data-ejf-body] { display: none !important; }\
/* We clone a real context group (Development / More fields) for exact chrome, then swap the chevron path in\
   JS - down caret when open, right caret when collapsed - matching how Jira itself toggles it (no CSS rotate).\
   The cloned group ships without a full card border, so we draw our own complete bordered card and drop the\
   inner wrapper partial border so we do not double up. */\
#ejf-side-group.ejf-ta-native { margin: 8px 0; border: 1px solid var(--ds-border, #091e4224); border-radius: 8px; box-sizing: border-box; overflow: hidden; }\
#ejf-side-group.ejf-ta-native > div { border: none; }\
/* Kill the lingering focus ring on the (cloned) header button after a collapse-toggle click - the cloned\
   role=button keeps focus and Jira draws a blue outline/box-shadow around the whole card, which we do not\
   want on this static toggle. */\
#ejf-side-group:focus, #ejf-side-group:focus-within, #ejf-side-group:focus-visible,\
#ejf-side-group *:focus, #ejf-side-group *:focus-visible,\
#ejf-side-header:focus, #ejf-side-header:focus-visible { outline: none !important; box-shadow: none !important; }\
/* Manual fallback path: drawn by hand to mimic the native group when the clone template is unavailable. */\
#ejf-side-group.ejf-ta-manual { margin: 8px 0; padding: 0 16px 4px; border: 1px solid var(--ds-border, #091e4224); border-radius: 8px; }\
#ejf-side-group.ejf-ta-manual.collapsed { padding-bottom: 0; }\
#ejf-side-header { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; padding: 14px 0; }\
#ejf-side-header .ejf-side-chevron { display: inline-flex; color: var(--ds-icon-subtle, #626f86); }\
#ejf-side-header .ejf-side-chevron svg { width: 16px; height: 16px; }\
#ejf-side-header .ejf-side-htitle { flex: 1; font-weight: 600; font-size: 16px; line-height: 1; color: var(--ds-text, #172b4d); }\
#ejf-side-group .ejf-side-body { padding-bottom: 8px; padding-right: 14px; }\
.ejf-side-subhead { display: flex; align-items: center; gap: 8px; margin: 2px 0 4px; }\
.ejf-side-subhead #ejf-sd-title { flex: 1; font-weight: 600; font-size: 12px; color: var(--ds-text-subtle, #44546f); }\
#ejf-side-group #ejf-sd-mode { font-size: 10px; background: var(--ds-background-neutral, #091e420f); color: var(--ds-text-subtle, #44546f); padding: 1px 6px; border-radius: 8px; }\
#ejf-side-group #ejf-sd-status { padding: 4px 0; border-bottom: none; color: var(--ds-text-subtlest, #626f86); }\
#ejf-side-group #ejf-sd-loglink { display: none; padding: 6px 0; border-bottom: 1px solid var(--ds-border, #091e4224); background: transparent; }\
#ejf-side-group #ejf-sd-loglink.has-hits { display: block; }\
#ejf-side-group #ejf-sd-loglink .ejf-sd-loglink-head { color: var(--ds-text-warning, #974f0c); }\
#ejf-side-group #ejf-sd-exccluster { display: none; padding: 6px 0; border-bottom: 1px solid var(--ds-border, #091e4224); background: transparent; }\
#ejf-side-group #ejf-sd-exccluster.has-hits { display: block; }\
#ejf-side-group #ejf-sd-exccluster .ejf-sd-exccluster-head { color: var(--ds-text, #172b4d); }\
#ejf-side-group #ejf-sd-exccluster .ejf-exc-member a { color: var(--ds-link, #0c66e4); }\
/* Responsive 2-up grid: two columns once the context column is wide enough (each cell >= 280px),\
   automatically collapsing to one column when narrow. align-items:stretch so both cards in a row share\
   the height of the taller one (left + right column line up). */\
#ejf-side-group #ejf-sd-list { overflow: visible; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); column-gap: 18px; align-items: stretch; }\
/* Each card is position:relative + bottom padding so the created date can be pinned to the bottom-right\
   (absolute) of the STRETCHED cell - so the dates line up across the two columns even when one card has\
   less content than the other (the short card no longer floats its date mid-card with a gap below it). */\
#ejf-side-group #ejf-sd-list li { position: relative; padding: 7px 0 22px; border-bottom: 1px solid var(--ds-border, #091e4224); }\
#ejf-side-group .ejf-sd-date { position: absolute; right: 0; bottom: 7px; margin-top: 0; }\
/* With a grid the simple :last-child no-border rule is wrong (only kills one of the bottom row); leave\
   borders on every item - a faint divider under each card reads fine in either column count. */\
#ejf-side-group #ejf-sd-list a, #ejf-side-group .ejf-sd-link { color: var(--ds-link, #0c66e4); }\
#ejf-side-group .ejf-sd-sum { color: var(--ds-text, #172b4d); }\
#ejf-side-group .ejf-sd-meta, #ejf-side-group .ejf-sd-score, #ejf-side-group .ejf-sd-date { color: var(--ds-text-subtlest, #626f86); }\
#ejf-side-group .ejf-sd-proj { background: var(--ds-background-neutral, #091e420f); color: var(--ds-text-subtle, #44546f); }\
#ejf-side-group .ejf-sd-link.ejf-sd-linked { color: var(--ds-text-success, #216e4e); }',

    injectCss: function () {
        if (!EJF_SD.ui._cssInjected) { GM_addStyle(EJF_SD.ui.css); EJF_SD.ui._cssInjected = true; }
    },

    // Brief transient message (e.g. sync started/finished), independent of the panel.
    toast: function (msg) {
        EJF_SD.ui.injectCss();
        var $t = $('#ejf-sd-toast');
        if (!$t.length) { $t = $('<div id="ejf-sd-toast"></div>').appendTo(document.body); }
        $t.text(msg).show();
        if (EJF_SD.ui._toastTimer) { clearTimeout(EJF_SD.ui._toastTimer); }
        EJF_SD.ui._toastTimer = setTimeout(function () { $('#ejf-sd-toast').fadeOut(400); }, 4000);
    },

    setStatus: function (msg) { $('#ejf-sd-status').text(msg); },

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
        if (Object.prototype.hasOwnProperty.call(EJF_SD.ui._renderedCache, key)) {
            return Promise.resolve(EJF_SD.ui._renderedCache[key]);
        }
        return new Promise(function (resolve) {
            $.ajax({ url: EJF_SD.HOST + '/rest/api/2/issue/' + key + '?fields=description&expand=renderedFields', dataType: 'json' })
                .done(function (d) {
                    var html = (d && d.renderedFields && d.renderedFields.description) || '';
                    EJF_SD.ui._renderedCache[key] = html;
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
        EJF_SD.ui.injectCss();
        EJF_SD.ui._tipKey = r.key;
        var $tip = $('#ejf-sd-tip');
        if (!$tip.length) { $tip = $('<div id="ejf-sd-tip"></div>').appendTo(document.body); }
        $tip.empty();
        EJF_SD.ui._watchMedia($tip[0]);   // arm the media killer for this tip (catches Jira's async hydration)
        $('<div class="ejf-sd-tip-title"></div>').text(r.key + ' — ' + (r.summary || '')).appendTo($tip);
        if (meta) { $('<div class="ejf-sd-tip-meta"></div>').text(meta).appendTo($tip); }
        var $desc = $('<div class="ejf-sd-tip-desc"></div>').appendTo($tip);

        function paintHtml($el, htmlStr) {
            // Jira's own rendered HTML; strip any <script>/<style> defensively before injecting.
            var clean = String(htmlStr).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
            // Strip embedded media AT THE STRING LEVEL so the resource never enters the DOM / starts loading.
            // Jira server-renders an attached video as a legacy <object type="video/mp4">…<embed></object>
            // (confirmed from renderedFields), which the browser autoplays. Replace those whole blocks - plus
            // any <video>/<audio>/<iframe> - with a static placeholder before injecting. (_killMedia below is
            // the belt-and-suspenders DOM pass for any other media shape, e.g. SDK-hydrated data-media nodes.)
            var MEDIA_PH = '<div class="ejf-sd-tip-media">▶ media — open the issue to view</div>';
            clean = clean
                .replace(/<object\b[\s\S]*?<\/object>/gi, MEDIA_PH)
                .replace(/<(video|audio|iframe)\b[\s\S]*?<\/\1>/gi, MEDIA_PH)
                .replace(/<(?:video|audio|iframe|embed|source)\b[^>]*\/?>/gi, '');   // stray self-closing/void media tags
            $el.removeClass('ejf-sd-tip-dim').addClass('ejf-sd-tip-html').html(clean);
            EJF_SD.ui._killMedia($tip[0]);   // belt-and-suspenders DOM pass (covers SDK-hydrated media, etc.)
        }

        var cached = EJF_SD.ui._renderedCache[r.key];
        if (typeof cached === 'string') {
            if (cached) { paintHtml($desc, cached); }
            else { $desc.addClass('ejf-sd-tip-dim').text('(no description)'); }
            EJF_SD.ui._positionTip($tip, anchor);
            return;
        }

        // Placeholder: the flattened stored text, shown immediately so there's no hover lag.
        var flat = (r.description || '').replace(/\s+/g, ' ').trim();
        if (flat) { $desc.text(flat); } else { $desc.addClass('ejf-sd-tip-dim').text('Loading…'); }
        EJF_SD.ui._positionTip($tip, anchor);

        EJF_SD.ui._getRendered(r.key).then(function (htmlStr) {
            if (EJF_SD.ui._tipKey !== r.key) { return; }   // mouse moved to another row already
            var $live = $('#ejf-sd-tip');
            var $d = $live.find('.ejf-sd-tip-desc');
            if (!$d.length) { return; }
            if (htmlStr) { paintHtml($d, htmlStr); }
            else if (!flat) { $d.addClass('ejf-sd-tip-dim').text('(no description)'); }
            EJF_SD.ui._positionTip($live, anchor);
        });
    },

    _hideTip: function () {
        EJF_SD.ui._tipKey = null;
        if (EJF_SD.ui._tipMediaObs) { try { EJF_SD.ui._tipMediaObs.disconnect(); } catch (e) { /* ignore */ } EJF_SD.ui._tipMediaObs = null; }
        $('#ejf-sd-tip').css('display', 'none');
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
            if (/ejf-sd-tip-media/.test(cls)) { return false; }   // our own placeholder - never re-process
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
            ph.className = 'ejf-sd-tip-media';
            ph.textContent = '▶ media — open the issue to view';
            if (top.parentNode) { top.parentNode.replaceChild(ph, top); }
        }
    },

    // Arm a short-lived MutationObserver on the tip so media the page's SDK injects LATER (async hydration)
    // is also stripped. Our placeholder divs don't match _killMedia's selector, so this can't loop. Auto-
    // disconnects after a few seconds (hydration is near-instant) and on _hideTip.
    _tipMediaObs: null,
    _watchMedia: function (root) {
        if (EJF_SD.ui._tipMediaObs) { try { EJF_SD.ui._tipMediaObs.disconnect(); } catch (e) { /* ignore */ } EJF_SD.ui._tipMediaObs = null; }
        if (!root || typeof MutationObserver !== 'function') { return; }
        var obs = new MutationObserver(function () { EJF_SD.ui._killMedia(root); });
        try { obs.observe(root, { childList: true, subtree: true }); } catch (e) { return; }
        EJF_SD.ui._tipMediaObs = obs;
        setTimeout(function () { if (EJF_SD.ui._tipMediaObs === obs) { obs.disconnect(); EJF_SD.ui._tipMediaObs = null; } }, 5000);
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
        var $p = $('#ejf-sd-panel');
        if (!$p.length) { return; }
        if (EJF_SD.ui._attachmentViewerOpen()) { $p.css('display', 'none'); }
        else if ($p.css('display') === 'none') { $p.css('display', ''); }
    },

    // Apply a saved {left, top} to the panel, clamped so it always stays on-screen (the window may be
    // smaller than when the position was saved). Switching to left/top overrides the default right/bottom
    // anchoring from the CSS. A null/invalid saved value leaves the default bottom-right placement alone.
    _applyPos: function ($p) {
        var pos = null;
        try { if (typeof GM_getValue === 'function') { pos = GM_getValue(EJF_SD.ui.POS_KEY, null); } } catch (e) { pos = null; }
        if (!pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') { return; }
        var el = $p[0];
        var w = el.offsetWidth || 340, h = el.offsetHeight || 60;
        var maxLeft = Math.max(0, window.innerWidth - w);
        var maxTop = Math.max(0, window.innerHeight - h);
        var left = Math.min(Math.max(0, pos.left), maxLeft);
        var top = Math.min(Math.max(0, pos.top), maxTop);
        $p.css({ left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' });
        el._ejfTop = top;                 // remember the intended top so _fitVertical can re-anchor on expand
        EJF_SD.ui._fitVertical();
    },

    // Keep the (expanded) panel on-screen vertically. When the panel is positioned by a dragged/saved top
    // and the expanded panel would run off the BOTTOM of the viewport, flip to "drop-up": pin it by the
    // bottom and reverse the column so the title bar stays put and the list grows UPWARD above it (height
    // capped to the room above so its top never leaves the screen). Only acts when we manage the position
    // via top (user dragged it, or a saved position was restored); the default bottom-anchored placement
    // already grows upward correctly and is left untouched.
    _fitVertical: function () {
        var $p = $('#ejf-sd-panel');
        if (!$p.length) { return; }
        var el = $p[0];
        if (typeof el._ejfTop !== 'number') { return; }
        if ($p.hasClass('collapsed')) {                 // collapsed: just keep the title at the intended top
            $p.removeClass('ejf-sd-up');
            el.style.maxHeight = '';
            el.style.bottom = 'auto';
            el.style.top = el._ejfTop + 'px';
            return;
        }
        var margin = 8, vh = window.innerHeight;
        // Reset to a plain top-anchored layout to measure the full expanded height at the intended top.
        $p.removeClass('ejf-sd-up');
        el.style.maxHeight = '';
        el.style.bottom = 'auto';
        el.style.top = el._ejfTop + 'px';
        var headEl = $p.find('#ejf-sd-head')[0];
        var headerH = headEl ? headEl.offsetHeight : 36;
        var fullH = el.offsetHeight;
        if (el._ejfTop + fullH <= vh - margin) { return; }   // fits growing down -> keep the normal layout
        // Would overflow the bottom -> drop up: pin the panel bottom at the header's bottom edge.
        var headerBottom = el._ejfTop + headerH;
        el.style.top = 'auto';
        el.style.bottom = (vh - headerBottom) + 'px';
        el.style.maxHeight = Math.max(80, Math.min(Math.round(vh * 0.52), headerBottom - margin)) + 'px';
        $p.addClass('ejf-sd-up');
    },

    // Make the panel draggable by its header. Persists the final position to GM storage on drop so it is
    // restored on the next page load. The collapse "–" control is excluded so clicking it still toggles.
    _makeDraggable: function ($p) {
        var el = $p[0];
        var $head = $p.find('#ejf-sd-head');
        var dragging = false, startX = 0, startY = 0, baseLeft = 0, baseTop = 0;

        // We drag by the HEADER's intended top (el._ejfTop) and let _fitVertical decide, on every move,
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
            el._ejfTop = top;                 // _fitVertical sets top/bottom from this (anchor or drop-up)
            EJF_SD.ui._fitVertical();
            e.preventDefault();
        }
        function onUp() {
            if (!dragging) { return; }
            dragging = false;
            $p.removeClass('ejf-sd-dragging');
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('mouseup', onUp, true);
            var rect = el.getBoundingClientRect();
            var top = (typeof el._ejfTop === 'number') ? el._ejfTop : Math.round(rect.top);
            try { if (typeof GM_setValue === 'function') { GM_setValue(EJF_SD.ui.POS_KEY, { left: Math.round(rect.left), top: top }); } } catch (e) { /* ignore */ }
            EJF_SD.ui._fitVertical();
        }
        $head.on('mousedown', function (e) {
            if (e.which && e.which !== 1) { return; }                 // left button only
            if ($(e.target).closest('#ejf-sd-collapse').length) { return; }  // let the collapse toggle work
            // Drag relative to the HEADER's current top (works whether we're top-anchored or in drop-up),
            // so the header tracks the cursor and _fitVertical re-evaluates up/down on every move.
            var hTop = $head[0].getBoundingClientRect().top;
            baseLeft = el.getBoundingClientRect().left; baseTop = hTop;
            el._ejfTop = hTop;
            startX = e.clientX; startY = e.clientY;
            dragging = true;
            $p.addClass('ejf-sd-dragging');
            document.addEventListener('mousemove', onMove, true);
            document.addEventListener('mouseup', onUp, true);
            e.preventDefault();
        });
    },

    // Panel style: 'sidebar' (default - integrated into Jira's context column, between Details and
    // Development) or 'floating' (the original draggable box on document.body). Persisted in GM 'sdPanelStyle'.
    mode: function () {
        try {
            if (typeof GM_getValue === 'function') {
                return (GM_getValue('sdPanelStyle', 'sidebar') === 'floating') ? 'floating' : 'sidebar';
            }
        } catch (e) { /* ignore */ }
        return 'sidebar';
    },

    // Flip the panel style and re-mount in the new location (no reload). Called from the settings overlay.
    toggleStyle: function () {
        var next = (EJF_SD.ui.mode() === 'sidebar') ? 'floating' : 'sidebar';
        try { if (typeof GM_setValue === 'function') { GM_setValue('sdPanelStyle', next); } } catch (e) { /* ignore */ }
        $('#ejf-sd-panel').remove();
        $('#ejf-side-group').remove();
        if (EJF_SD.ui.currentKey && /^EBR-/.test(EJF_SD.ui.currentKey)) { EJF_SD.ui.render(EJF_SD.ui.currentKey); }
        else if (EJF_SD.ui.currentKey && EJF_SD.ui._isDefectKey(EJF_SD.ui.currentKey)) { EJF_SD.ui.renderReports(EJF_SD.ui.currentKey); }
        refreshMenu();
    },

    // True once the panel chrome (specifically its shared inner list) is mounted in EITHER location. Used by
    // ensure() to decide whether a (re)render is needed - in sidebar mode Jira's React re-renders can wipe
    // our injected section, and this flips back to false so the observer re-mounts + repopulates it.
    _chromePresent: function () { return !!document.getElementById('ejf-sd-list'); },

    // SVG chevron matching Jira's native context-group caret (points down when expanded; CSS rotates it -90°
    // when collapsed). Same path Jira uses for its Details / Development group headers.
    _chevronSvg: '<svg fill="none" viewBox="-8 -8 32 32" width="16" height="16" role="presentation"><path fill="currentColor" d="m14.53 6.03-6 6a.75.75 0 0 1-1.004.052l-.056-.052-6-6 1.06-1.06L8 10.44l5.47-5.47z"></path></svg>',

    // The two chevron path shapes Jira uses (it swaps the path rather than rotating): down caret when the
    // group is open, right caret when collapsed.
    _CHEV_DOWN: 'm14.53 6.03-6 6a.75.75 0 0 1-1.004.052l-.056-.052-6-6 1.06-1.06L8 10.44l5.47-5.47z',
    _CHEV_RIGHT: 'm6.03 1.47 6 6a.75.75 0 0 1 .052 1.004l-.052.056-6 6-1.06-1.06L10.44 8 4.97 2.53z',

    // Point the group's chevron the right way (open = down, collapsed = right). Works for both the cloned
    // native chevron and the hand-built one (both carry [data-ejf-chevron]).
    _setChevron: function (group, collapsed) {
        var p = group && group.querySelector('[data-ejf-chevron] path');
        if (p) { p.setAttribute('d', collapsed ? EJF_SD.ui._CHEV_RIGHT : EJF_SD.ui._CHEV_DOWN); }
    },

    // Ensure the panel chrome (shared inner ids: #ejf-sd-title, #ejf-sd-mode, #ejf-sd-status, #ejf-sd-loglink,
    // #ejf-sd-list) exists in the active location. Sidebar by default; falls back to the floating box if the
    // Jira context column / Details anchor isn't in the DOM (yet).
    _ensurePanel: function () {
        EJF_SD.ui.injectCss();
        if (EJF_SD.ui.mode() === 'sidebar' && EJF_SD.ui._ensureSidebar()) {
            if ($('#ejf-sd-panel').length) { $('#ejf-sd-panel').remove(); }   // drop a lingering floating box
            return;
        }
        if ($('#ejf-side-group').length) { $('#ejf-side-group').remove(); }   // floating mode / no sidebar anchor
        EJF_SD.ui._ensureFloating();
    },

    // The original floating, draggable panel on document.body (now opt-in / the fallback when the sidebar
    // anchor is missing). Lives outside Jira's React tree, so it survives re-renders without re-mounting.
    _ensureFloating: function () {
        if ($('#ejf-sd-panel').length) { return; }
        var $p = $(
            '<div id="ejf-sd-panel">' +
            '  <div id="ejf-sd-head"><span id="ejf-sd-title">Similar defects</span>' +
            '    <span id="ejf-sd-mode">Keyword</span><span id="ejf-sd-collapse" title="Collapse / expand">–</span></div>' +
            '  <div id="ejf-sd-status"></div>' +
            '  <div id="ejf-sd-loglink"></div>' +
            '  <div id="ejf-sd-exccluster"></div>' +
            '  <ul id="ejf-sd-list"></ul>' +
            '</div>'
        );
        // Restore the saved minimized state before showing the panel.
        var collapsed = false;
        try { if (typeof GM_getValue === 'function') { collapsed = !!GM_getValue(EJF_SD.ui.COLLAPSE_KEY, false); } } catch (e) { collapsed = false; }
        if (collapsed) { $p.addClass('collapsed'); }
        $p.find('#ejf-sd-collapse').text(collapsed ? '+' : '–');
        $p.find('#ejf-sd-collapse').on('click', function () {
            var isCollapsed = $('#ejf-sd-panel').toggleClass('collapsed').hasClass('collapsed');
            $(this).text(isCollapsed ? '+' : '–');   // reflect state in the control
            try { if (typeof GM_setValue === 'function') { GM_setValue(EJF_SD.ui.COLLAPSE_KEY, isCollapsed); } } catch (e) { /* ignore */ }
            EJF_SD.ui._fitVertical();   // on expand, grow upward if there's no room below; on collapse, reset
        });
        $p.appendTo(document.body);
        EJF_SD.ui._applyPos($p);          // restore the user's saved position (if any)
        EJF_SD.ui._makeDraggable($p);     // wire up header dragging
        EJF_SD.ui.updateVisibility();     // stay hidden if an attachment viewer is already open
    },

    // Mount (or verify) the integrated "Triage Assistant" group in Jira's context column, immediately after
    // the Details group (so it sits between Details and Development). Returns true once the chrome (with the
    // shared inner ids) is present, false if the Details anchor isn't in the DOM yet (caller then falls back
    // to the floating box). Cheap fast-path when already mounted, since the observer calls this often.
    SIDE_COLLAPSE_KEY: 'sdSideCollapsed',

    // The inner body of the group (subhead + the shared chrome ids), shared by the clone and manual builders.
    _sidebarBodyHtml: function () {
        return '<div class="ejf-side-subhead"><span id="ejf-sd-title">Similar defects</span><span id="ejf-sd-mode">Keyword</span></div>' +
               '<div id="ejf-sd-status"></div>' +
               '<div id="ejf-sd-loglink"></div>' +
               '<div id="ejf-sd-exccluster"></div>' +
               '<ul id="ejf-sd-list"></ul>';
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
        if (document.getElementById('ejf-side-group') && document.getElementById('ejf-sd-list')) { return true; }
        // The Details slot is our anchor (data-vc is stable; the atomic class names are not). Fall back to the
        // details-group container if the slot wrapper isn't present.
        var anchor = document.querySelector('[data-vc="issue-view-context-items-details-panel-slot"]')
            || document.querySelector('[data-vc="issue-view-context-group-details-group"]');
        if (!anchor || !anchor.parentNode) { return false; }

        // Drop a stale wrapper React may have left behind (body wiped but shell kept) before re-mounting.
        var old = document.getElementById('ejf-side-group');
        if (old && old.parentNode) { old.parentNode.removeChild(old); }

        var collapsed = false;
        try { if (typeof GM_getValue === 'function') { collapsed = !!GM_getValue(EJF_SD.ui.SIDE_COLLAPSE_KEY, false); } } catch (e) { collapsed = false; }

        var group = null, headerClickTarget = null;

        // Preferred: CLONE a real context group so the card chrome / header / chevron / title font match Jira
        // exactly. Prefer a NON-Details group (Development / More fields) - its header padding + chevron
        // position are what the user wants to match; the Details group is the always-open "primary" group with
        // slightly different header padding. We clone the group's inner wrapper (it stays in the DOM even when
        // collapsed - the body content just sits in a hidden div), gut the body, drop our content in, strip the
        // clone's identifying attributes, point the chevron the right way, and re-wire the collapse toggle (the
        // clone is static DOM with no React handlers). Marked with [data-ejf-body] / [data-ejf-chevron].
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
                    EJF_SD.ui._stripAttrs(clone);                 // (keeps element refs above valid)
                    if (chevronEl) { chevronEl.setAttribute('data-ejf-chevron', '1'); }
                    titleEl.textContent = 'Triage Assistant';
                    // We cloned a COLLAPSED group, whose body wrapper carries Jira's collapse machinery (a
                    // `hidden` attribute, a nested `<div hidden>`, and/or inline height:0 / overflow on
                    // wrappers) that survives the clone and keeps content invisible even when expanded.
                    // Rather than try to undo all of that, throw the cloned body wrapper away entirely and
                    // drop in a clean, baggage-free body element in its place. Our own `.collapsed` class is
                    // then the only thing that hides/shows it.
                    var freshBody = document.createElement('div');
                    freshBody.setAttribute('data-ejf-body', '1');
                    freshBody.className = 'ejf-side-body';
                    freshBody.innerHTML = EJF_SD.ui._sidebarBodyHtml();
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
                    var ejfSecs = clone.querySelectorAll('section');
                    for (var ejfSi = 0; ejfSi < ejfSecs.length; ejfSi++) {
                        var sec = ejfSecs[ejfSi];
                        if (sec.style && sec.style.setProperty) {
                            sec.style.setProperty('position', 'static', 'important');
                            sec.style.setProperty('top', 'auto', 'important');
                        }
                    }
                    clone.id = 'ejf-side-group';
                    clone.classList.add('ejf-ta-native');
                    headerClickTarget = btnEl || clone;
                    group = clone;
                }
            } catch (e) { group = null; }
        }

        // Fallback: hand-built group (used only if the native template wasn't found / clone failed).
        if (!group) {
            var $g = $(
                '<div id="ejf-side-group" class="ejf-ta-manual">' +
                '  <div id="ejf-side-header" role="button" tabindex="0" aria-expanded="true">' +
                '    <span class="ejf-side-chevron" data-ejf-chevron="1">' + EJF_SD.ui._chevronSvg + '</span>' +
                '    <span class="ejf-side-htitle">Triage Assistant</span>' +
                '  </div>' +
                '  <div class="ejf-side-body" data-ejf-body="1">' + EJF_SD.ui._sidebarBodyHtml() + '</div>' +
                '</div>'
            );
            group = $g[0];
            headerClickTarget = group.querySelector('#ejf-side-header');
        }

        if (collapsed) { group.classList.add('collapsed'); }
        EJF_SD.ui._setChevron(group, collapsed);   // point the chevron the right way for the initial state

        // Collapse toggle (shared by both paths): reflect on the root class + aria-expanded + chevron, persist.
        if (headerClickTarget) {
            headerClickTarget.style.cursor = 'pointer';
            headerClickTarget.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            headerClickTarget.addEventListener('click', function () {
                var isColl = group.classList.toggle('collapsed');
                EJF_SD.ui._setChevron(group, isColl);
                try { headerClickTarget.setAttribute('aria-expanded', isColl ? 'false' : 'true'); } catch (e) { /* ignore */ }
                try { if (typeof GM_setValue === 'function') { GM_setValue(EJF_SD.ui.SIDE_COLLAPSE_KEY, isColl); } } catch (e2) { /* ignore */ }
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
    _markDupButton: function (defectKey) {
        var $dup = $('<span class="ejf-sd-link"></span>')
            .text('Attach')
            .attr('title', 'Link this bug report as a duplicate of ' + defectKey);
        $dup.on('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            var $btn = $(this);
            if ($btn.hasClass('ejf-sd-linked') || $btn.hasClass('ejf-sd-linking')) { return; }
            var ebr = EJF_SD.ui.currentKey;
            if (!ebr) { return; }
            if (!confirm('Link ' + ebr + ' as a duplicate of ' + defectKey + ' and set it to Attached?')) { return; }
            $btn.addClass('ejf-sd-linking').text('…');
            // Single call: the Attached transition sets the status, resolution AND the duplicate link at once.
            EJF_SD.link.attachDuplicate(ebr, defectKey, 'Attached', 'Duplicate').then(function (res) {
                EJF_SD.ui._hideTip();
                $btn.removeClass('ejf-sd-linking').addClass('ejf-sd-linked').text(res.attached ? '✓ attached' : '✓ linked');
                var msg = res.attached
                    ? ('Linked ' + ebr + ' as a duplicate of ' + defectKey + ' and set it to Attached.')
                    : ('Linked ' + ebr + ' as a duplicate of ' + defectKey + ' (could not set Attached).');
                if (!res.linked) { msg = 'Set ' + ebr + ' to Attached, but the duplicate link failed.'; }
                // Soft-patch the status lozenge in place - no full reload. The duplicate link is created
                // server-side and shows in Jira's "Linked work items" section on the next natural refresh.
                if (res.attached) { EJF_SD.ui.softRefreshStatus('Attached'); }
                EJF_SD.ui.toast(msg);
            }, function (e) {
                console.log('[EJF-SD] mark-dup failed (attachDuplicate rejected):', e && e.message || e);
                $btn.removeClass('ejf-sd-linking').text('Attach');
                EJF_SD.ui.toast('Could not link: ' + (e && e.message || e));
            });
        });
        return $dup;
    },

    _item: function (r) {
        var pct = (typeof r.pct === 'number') ? r.pct : 0; // display % is computed per-mode in render()
        var meta = r.status || '';
        if (r.resolution) { meta += (meta ? ' · ' : '') + r.resolution; }
        if (r.staleNote) { meta += (meta ? ' · ' : '') + r.staleNote; }   // Feature A: explain the demotion
        var $li = $('<li></li>');
        if (r.stale) { $li.addClass('ejf-sd-stale'); }                    // Feature A: grey out stale-closed matches
        // Feature C: hover preview - a styled card (built in _showTip) showing the summary, full description
        // (incl. reproduction steps) and status, so the triager can judge a match without navigating.
        $li.on('mouseenter', function () { EJF_SD.ui._showTip(r, this, meta); });
        $li.on('mouseleave', function () { EJF_SD.ui._hideTip(); });
        $('<a></a>').attr('href', '/browse/' + r.key).attr('target', '_self').text(r.key).appendTo($li);
        $('<span class="ejf-sd-proj"></span>').text(r.project || '').appendTo($li);
        $('<span class="ejf-sd-score"></span>').text(pct + '%').appendTo($li);
        // Feature B: one-click "mark this bug report as a duplicate of that defect" (links the open EBR to r.key).
        EJF_SD.ui._markDupButton(r.key).appendTo($li);
        $('<div class="ejf-sd-sum"></div>').text(r.summary || '').appendTo($li);
        if (meta) { $('<div class="ejf-sd-meta"></div>').text(meta).appendTo($li); }
        var created = EJF_SD.util.fmtDate(r.created);
        if (created) { $('<div class="ejf-sd-date"></div>').text('Created ' + created).appendTo($li); }
        return $li;
    },

    // Row builder for the EDR "matching bug reports" view: like _item but with NO "Mark dup" control (the
    // dup action is an EBR-page concept) and the link opens in a new tab so the defect page stays put.
    _reportItem: function (r) {
        var pct = (typeof r.pct === 'number') ? r.pct : 0;
        var meta = r.status || '';
        if (r.resolution) { meta += (meta ? ' · ' : '') + r.resolution; }
        var $li = $('<li></li>');
        $li.on('mouseenter', function () { EJF_SD.ui._showTip(r, this, meta); });
        $li.on('mouseleave', function () { EJF_SD.ui._hideTip(); });
        $('<a></a>').attr('href', '/browse/' + r.key).attr('target', '_blank').text(r.key).appendTo($li);
        $('<span class="ejf-sd-proj"></span>').text(r.project || '').appendTo($li);
        $('<span class="ejf-sd-score"></span>').text(pct + '%').appendTo($li);
        $('<div class="ejf-sd-sum"></div>').text(r.summary || '').appendTo($li);
        if (meta) { $('<div class="ejf-sd-meta"></div>').text(meta).appendTo($li); }
        var created = EJF_SD.util.fmtDate(r.created);
        if (created) { $('<div class="ejf-sd-date"></div>').text('Created ' + created).appendTo($li); }
        return $li;
    },

    // Read the open issue's text from the DOM (reusing the Translate selectors); fall back to a REST GET.
    getIssueText: function (key) {
        var title = $("h1[data-testid='issue.views.issue-base.foundation.summary.heading']").text() || '';
        // Grab the WHOLE rich-text description container (not just the first couple of paragraphs) so the
        // cleaner sees everything, then strip boilerplate. Same normalization as the stored side.
        var descText = $("div[data-component-selector='jira-issue-view-rich-text-inline-edit-view-container']").text() || '';
        if (descText.replace(/\s+/g, '').length > 0) {
            return Promise.resolve(EJF_SD.util.cleanForCompare(title, descText));
        }
        // DOM not ready / empty body - fall back to the REST API.
        return new Promise(function (resolve) {
            $.ajax({ url: EJF_SD.HOST + '/rest/api/2/issue/' + key + '?fields=summary,description', dataType: 'json' })
                .done(function (d) {
                    var f = d.fields || {};
                    resolve(EJF_SD.util.cleanForCompare(f.summary || title, EJF_SD.util.toPlainText(f.description)));
                })
                .fail(function () { resolve(EJF_SD.util.cleanForCompare(title, descText)); });
        });
    },

    // Fetch (and cache per key) the open bug report's creation date, used by the stale-match demotion to
    // compare against a candidate defect's fix date. Resolves to an ISO string, or null if unavailable.
    _createdCache: {},
    _getCreated: function (key) {
        if (Object.prototype.hasOwnProperty.call(EJF_SD.ui._createdCache, key)) {
            return Promise.resolve(EJF_SD.ui._createdCache[key]);
        }
        return new Promise(function (resolve) {
            $.ajax({ url: EJF_SD.HOST + '/rest/api/2/issue/' + key + '?fields=created', dataType: 'json' })
                .done(function (d) {
                    var created = (d && d.fields && d.fields.created) || null;
                    EJF_SD.ui._createdCache[key] = created;
                    resolve(created);
                })
                .fail(function () { EJF_SD.ui._createdCache[key] = null; resolve(null); });
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
        if (Object.prototype.hasOwnProperty.call(EJF_SD.ui._logScanCache, key)) {
            return Promise.resolve(EJF_SD.ui._logScanCache[key]);
        }
        return new Promise(function (resolve) {
            $.ajax({ url: EJF_SD.HOST + '/rest/api/3/issue/' + key + '?fields=attachment', dataType: 'json' })
                .done(function (d) {
                    var atts = (d && d.fields && d.fields.attachment) || [];
                    var logs = [];
                    for (var i = 0; i < atts.length; i++) {
                        var fn = atts[i].filename || '';
                        if (/\.txt$/i.test(fn) && /log/i.test(fn) && atts[i].content) { logs.push(atts[i]); }
                    }
                    if (!logs.length) { EJF_SD.ui._logScanCache[key] = {}; resolve({}); return; }
                    console.log('[EJF-SD] log scan ' + key + ': ' + logs.length + ' log attachment(s)');
                    var merged = {}, pending = logs.length;
                    function mergeFound(found) {
                        Object.keys(found || {}).forEach(function (k) {
                            if (!merged[k]) { merged[k] = { defect: k, count: 0, msg: found[k].msg, loose: !!found[k].loose }; }
                            merged[k].count += found[k].count;
                            if (!found[k].loose) { merged[k].loose = false; }   // an exact hit upgrades it
                            if (!merged[k].msg && found[k].msg) { merged[k].msg = found[k].msg; }
                        });
                        if (--pending === 0) {
                            console.log('[EJF-SD] log scan ' + key + ': ' + Object.keys(merged).length + ' known defect(s) matched');
                            EJF_SD.ui._logScanCache[key] = merged;
                            resolve(merged);
                        }
                    }
                    logs.forEach(function (att) {
                        EJF_SD.ui._fetchText(att.content).then(function (txt) {
                            if (!txt) { mergeFound({}); return; }
                            EJF_SD.logsig.matchText(txt).then(mergeFound, function () { mergeFound({}); });
                        }, function () { mergeFound({}); });
                    });
                })
                .fail(function () { EJF_SD.ui._logScanCache[key] = {}; resolve({}); });
        });
    },

    // Populate the "Known defects in attached log" section of the panel (hidden unless there are hits). Each
    // entry links to the defect and reuses the same hover-preview card as the suggestions.
    renderLogLink: function (key) {
        var $box = $('#ejf-sd-loglink');
        if (!$box.length) { return; }
        $box.removeClass('has-hits').empty();
        EJF_SD.db.countDefectsOnly().then(function (n) {
            if (!n) { return; }   // no defects to match the log against yet
            EJF_SD.ui.scanIssueLog(key).then(function (found) {
                if (EJF_SD.ui.currentKey !== key) { return; }   // navigated to another issue meanwhile
                var keys = Object.keys(found || {});
                if (!keys.length) { return; }
                keys.sort(function (a, b) { return found[b].count - found[a].count || (a < b ? -1 : 1); });
                var $b = $('#ejf-sd-loglink');
                $b.empty();
                $('<div class="ejf-sd-loglink-head"></div>').text('⚠ Known defects in attached log (' + keys.length + ')').appendTo($b);
                var $ul = $('<ul></ul>').appendTo($b);
                keys.forEach(function (k) {
                    var $li = $('<li></li>');
                    $('<a></a>').attr('href', '/browse/' + k).attr('target', '_blank').text(k).appendTo($li);
                    if (found[k].loose) {   // matched only by crash site (same bug, different path)
                        $('<span class="ejf-sd-loose"></span>').text('~ similar')
                            .attr('title', 'Same crash site, reached via a different call path — possibly related').appendTo($li);
                    }
                    EJF_SD.ui._markDupButton(k).appendTo($li);   // same one-click "Mark dup" as the suggestions
                    $('<span class="count"></span>').text(found[k].count + '×').appendTo($li);
                    $li.on('mouseenter', function () { EJF_SD.logsig._showDefectTip(k, this); });
                    $li.on('mouseleave', function () { EJF_SD.logsig._hoverKey = null; if (EJF_SD.ui._hideTip) { EJF_SD.ui._hideTip(); } });
                    $ul.append($li);
                });
                $b.addClass('has-hits');
            });
        });
    },

    // Coalesce re-render requests. A single sync drives several "refresh the list" triggers in quick
    // succession - the sync's own completion, then embed.prepare()'s completion after the embed pass, and
    // (for autoSync) both the defect and EBR legs - and each render() empties + refills #ejf-sd-list, so the
    // list visibly rebuilds several times. Route those background triggers through here so a burst collapses
    // into ONE render of whichever view is currently open. (User-initiated renders - navigation, panel-style
    // toggle - still call render()/renderReports() directly for instant feedback.)
    _renderTimer: null,
    scheduleRender: function () {
        if (!EJF_SD.ui.currentKey) { return; }
        if (EJF_SD.ui._renderTimer) { clearTimeout(EJF_SD.ui._renderTimer); }
        EJF_SD.ui._renderTimer = setTimeout(function () {
            EJF_SD.ui._renderTimer = null;
            var k = EJF_SD.ui.currentKey;
            if (!k) { return; }
            if (/^EBR-/.test(k)) { EJF_SD.ui.render(k); }
            else if (EJF_SD.ui._isDefectKey(k)) { EJF_SD.ui.renderReports(k); }
        }, 600);
    },

    render: function (key) {
        EJF_SD.ui._ensurePanel();
        $('#ejf-sd-title').text('Similar defects');   // reset title (the panel is shared with the EDR reports view)
        $('#ejf-sd-exccluster').removeClass('has-hits').empty();   // defect-only section; clear it on the EBR view
        EJF_SD.ui.renderLogLink(key);   // scan the attached log for known defects (no need to open it)
        $('#ejf-sd-list').empty();
        EJF_SD.ui.setStatus('Finding similar defects…');
        EJF_SD.ui.getIssueText(key).then(function (text) {
            return EJF_SD.db.countDefectsOnly().then(function (n) {
                if (!n) {
                    EJF_SD.ui.setStatus('No local data yet – open the Tampermonkey menu and click “Sync defects now”.');
                    return;
                }
                if (!text) { EJF_SD.ui.setStatus('Could not read this issue’s text.'); return; }
                return EJF_SD.ui._getCreated(key).then(function (brCreated) {
                return EJF_SD.rank.suggestBest(text, key, brCreated).then(function (out) {
                    var results = out.results || [];
                    $('#ejf-sd-mode').text(out.mode);   // 'Hybrid' or 'Keyword'
                    if (!results.length) { EJF_SD.ui.setStatus('No similar defects found (' + n + ' indexed).'); return; }
                    EJF_SD.ui.setStatus(results.length + ' suggestions · ' + out.mode + ' · ' + n + ' indexed');
                    // Feature C: enrich the displayed results with each defect's full description (which
                    // includes the reproduction steps) for the hover tooltip. Only a handful of indexed-DB
                    // reads (just the shown results), so it's cheap.
                    return Promise.all(results.map(function (r) {
                        return EJF_SD.db.getDefect(r.key).then(function (rec) {
                            if (rec) { r.description = rec.description; r.created = rec.created; }
                            return r;
                        }, function () { return r; });
                    })).then(function () {
                        var $list = $('#ejf-sd-list');
                        $list.empty();   // clear atomically right before filling: a concurrent re-render (e.g. after an auto-sync) also emptied at its top, but both appended later - emptying here keeps each render self-contained and avoids doubled rows
                        for (var i = 0; i < results.length; i++) { $list.append(EJF_SD.ui._item(results[i])); }
                        EJF_SD.ui._fitVertical();   // list height changed - re-check it still fits / drops up
                    });
                });
                });
            });
        }).catch(function (e) { EJF_SD.ui.setStatus('Error: ' + (e && e.message || e)); });
    },

    // EDR (defect) view: rank the OPEN bug reports that best match this defect's description (keyword BM25),
    // and list them in the same panel. Mirrors render() but over the EBR index, with no log-scan / mark-dup.
    renderReports: function (key) {
        EJF_SD.ui._ensurePanel();
        $('#ejf-sd-title').text('Matching bug reports');
        $('#ejf-sd-loglink').removeClass('has-hits').empty();   // EBR-only section; unused on a defect
        $('#ejf-sd-list').empty();
        EJF_SD.ui.renderExceptionCluster(key);   // list other defects that reported the same exception
        EJF_SD.ui.setStatus('Finding matching bug reports…');
        EJF_SD.ui.getIssueText(key).then(function (text) {
            return EJF_SD.db.countEbr().then(function (n) {
                if (!n) {
                    EJF_SD.ui.setStatus('No bug reports synced yet – open the Tampermonkey menu and click “Sync bug reports now”.');
                    return;
                }
                if (!text) { EJF_SD.ui.setStatus('Could not read this defect’s text.'); return; }
                return EJF_SD.rank.suggestEbrBest(text, key).then(function (out) {
                    var results = out.results || [];
                    $('#ejf-sd-mode').text(out.mode);   // 'Hybrid' or 'Keyword'
                    if (!results.length) { EJF_SD.ui.setStatus('No matching bug reports found (' + n + ' open).'); return; }
                    EJF_SD.ui.setStatus(results.length + ' matches · ' + out.mode + ' · ' + n + ' open reports');
                    // Enrich with each report's full description for the hover preview (a handful of reads).
                    return Promise.all(results.map(function (r) {
                        return EJF_SD.db.getDefect(r.key).then(function (rec) {
                            if (rec) { r.description = rec.description; r.created = rec.created; }
                            return r;
                        }, function () { return r; });
                    })).then(function () {
                        var $list = $('#ejf-sd-list');
                        $list.empty();   // clear atomically right before filling (see render() - avoids doubled rows from a concurrent re-render)
                        for (var i = 0; i < results.length; i++) { $list.append(EJF_SD.ui._reportItem(results[i])); }
                        EJF_SD.ui._fitVertical();   // list height changed - re-check it still fits / drops up
                    });
                });
            });
        }).catch(function (e) { EJF_SD.ui.setStatus('Error: ' + (e && e.message || e)); });
    },

    // Populate the "Same exception" section: every OTHER defect that reported the same exception signature as
    // this one, each with its status (Open / Fixed). A sibling that is already FIXED while this defect is still
    // open is flagged "⚠ regression?". Hidden unless there are siblings. Reuses the shared cluster member rows.
    renderExceptionCluster: function (key) {
        var $box = $('#ejf-sd-exccluster');
        if (!$box.length) { return; }
        $box.removeClass('has-hits').empty();
        // Exact stack siblings ("Same exception") AND looser crash-site peers ("Possibly related").
        Promise.all([EJF_SD.logsig.siblingsForKey(key), EJF_SD.logsig.relatedForKey(key)]).then(function (res) {
            if (EJF_SD.ui.currentKey !== key) { return; }       // navigated to another issue meanwhile
            var siblings = res[0] || [], related = res[1] || [];
            if (!siblings.length && !related.length) { return; }
            return EJF_SD.db.getDefect(key).then(function (rec) {
                if (EJF_SD.ui.currentKey !== key) { return; }
                var currentResolved = !!(rec && (rec.resolution || rec.resolutiondate));
                EJF_SD.logsig._injectClusterCss();
                var $b = $('#ejf-sd-exccluster');
                $b.empty();
                // ⚠ regression flag: a peer that's already FIXED while this defect is still open.
                function regressionWarn(m) {
                    if (!((m.resolution || m.resolutiondate) && !currentResolved)) { return null; }
                    var warn = document.createElement('span');
                    warn.className = 'ejf-exc-badge warn';
                    warn.textContent = '⚠ regression?';
                    warn.title = 'This exception was already resolved in ' + m.key + ', but the current issue is still open – possible regression.';
                    return warn;
                }
                function section(headText, headTitle, list, marginTop) {
                    var $h = $('<div class="ejf-sd-exccluster-head"></div>').text(headText);
                    if (headTitle) { $h.attr('title', headTitle); }
                    if (marginTop) { $h.css('margin-top', '8px'); }
                    $h.appendTo($b);
                    var box = document.createElement('div');
                    box.className = 'ejf-exc-members';
                    list.forEach(function (m) { box.appendChild(EJF_SD.logsig._memberRowEl(m, regressionWarn(m))); });
                    $b.append(box);
                }
                if (siblings.length) { section('Same exception (' + siblings.length + ')', '', siblings, false); }
                if (related.length) { section('Possibly related (' + related.length + ')', 'Same crash site, reached via a different call path', related, siblings.length > 0); }
                $b.addClass('has-hits');
                EJF_SD.ui._fitVertical();
            });
        }).catch(function () { /* swallow - the section just stays hidden */ });
    },

    // When we land on an EDR that isn't in the local DB yet (e.g. a freshly created / just-converted defect),
    // kick off a quiet catch-up sync so it gets indexed. Guarded per key (once per session) and skipped while
    // a sync is already running or when the defect DB is empty (an empty DB is handled by the scheduler's
    // auto-initial build instead). The catch-up is incremental, so it cheaply fetches the new EDR.
    _autoSyncedKeys: {},
    _maybeSyncForDefect: function (key) {
        if (EJF_SD.ui._autoSyncedKeys[key]) { return; }
        if (EJF_SD.sync.running) { return; }
        EJF_SD.db.countDefectsOnly().then(function (n) {
            if (!n) { return; }   // empty defect DB - the scheduler's auto-initial build covers this
            return EJF_SD.db.getDefect(key).then(function (rec) {
                if (rec) { return; }   // already indexed - nothing to do
                EJF_SD.ui._autoSyncedKeys[key] = true;   // don't retrigger for this key this session
                console.log('[EJF-SD] ' + key + ' not in local DB - triggering catch-up sync');
                EJF_SD.sync.autoSync();   // quiet incremental catch-up (fetches the new defect/EO issue; embeds + refreshes)
            });
        });
    },

    // Keys that get the "Matching bug reports" (reverse) view: defects (EDR) AND EVE Online (EO) issues.
    // Both projects are in the synced defect scope (EJF_SD.SCOPE = "project in (EDR, EO)"), so the local
    // DB already holds them and renderReports works for either.
    _isDefectKey: function (key) { return /^(EDR|EO)-/.test(key || ''); },

    // Show/refresh the panel on EBR bug reports (similar defects) AND on EDR/EO issues (matching reports);
    // re-query when the issue key changes. Any other issue type removes the panel.
    ensure: function () {
        if (!savedVariables[5][1]) { return; }
        var $bc = $('a[data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]');
        if (!$bc.length) { return; }
        var key = $.trim($bc.first().text());
        var isEbr = /^EBR-/.test(key), isDefect = EJF_SD.ui._isDefectKey(key);
        if (!isEbr && !isDefect) {
            // neither a bug report nor a defect/EO issue - remove any stale panel (either style)
            if ($('#ejf-sd-panel').length) { $('#ejf-sd-panel').remove(); }
            if ($('#ejf-side-group').length) { $('#ejf-side-group').remove(); }
            EJF_SD.ui.currentKey = null;
            return;
        }
        // Skip only when the chrome is mounted AND it's the same issue. In sidebar mode a Jira re-render can
        // wipe our injected section; _chromePresent() then reports false and we re-mount + repopulate here.
        if (EJF_SD.ui._chromePresent() && EJF_SD.ui.currentKey === key) { return; }
        EJF_SD.ui.currentKey = key;
        if (isEbr) {
            EJF_SD.ui.render(key);              // bug report -> similar defects
        } else {
            EJF_SD.ui.renderReports(key);       // defect / EO issue -> matching open bug reports
            EJF_SD.ui._maybeSyncForDefect(key); // ...and index this issue if we don't have it yet
        }
    }
};


/* ---- consolidated in-page settings menu ---- */
// One Tampermonkey command ("⚙ Enhanced Jira – Settings…") opens this modal overlay, which replaces the
// long flat list of GM menu commands. It groups the feature on/off switches and, when the Triage Assistant
// is enabled, its actions (sync defects / sync bug reports / rebuild) + the embedding-backend switch +
// a live count of what's indexed. The existing toggle* functions still do the actual work; they call
// refreshMenu() which re-renders this overlay so it reflects the new state without closing.
EJF_SD.menu = {
    _cssInjected: false,
    css: '\
#ejf-menu-overlay { position: fixed; inset: 0; z-index: 10000; background: rgba(0,0,0,.5); display: flex;\
  align-items: center; justify-content: center; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; }\
#ejf-menu { width: 360px; max-height: 82vh; overflow-y: auto; background: #1D2125; color: #e6e6e6;\
  border: 1px solid #3a434d; border-radius: 8px; box-shadow: 0 8px 30px rgba(0,0,0,.55); font-size: 13px; }\
#ejf-menu .ejf-menu-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; background: #282d33; border-radius: 8px 8px 0 0; position: sticky; top: 0; }\
#ejf-menu .ejf-menu-head h2 { margin: 0; font-size: 14px; font-weight: 700; flex: 1; }\
#ejf-menu .ejf-menu-x { cursor: pointer; font-weight: 700; font-size: 18px; line-height: 1; padding: 0 4px; color: #9aa6b2; }\
#ejf-menu .ejf-menu-x:hover { color: #fff; }\
#ejf-menu .ejf-menu-sect { padding: 4px 14px 12px; }\
#ejf-menu .ejf-menu-sect h3 { margin: 12px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #7a8694; }\
#ejf-menu .ejf-menu-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid #2c333a; }\
#ejf-menu .ejf-menu-row:last-child { border-bottom: none; }\
#ejf-menu .ejf-menu-row .lbl { flex: 1; }\
#ejf-menu .ejf-menu-row .sub { display: block; color: #7a8694; font-size: 11px; margin-top: 2px; }\
#ejf-menu .ejf-sw { width: 38px; height: 20px; border-radius: 12px; background: #3a434d; position: relative; cursor: pointer; flex: 0 0 auto; transition: background .15s; }\
#ejf-menu .ejf-sw.on { background: #4caf7d; }\
#ejf-menu .ejf-sw .knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: left .15s; }\
#ejf-menu .ejf-sw.on .knob { left: 20px; }\
#ejf-menu .ejf-menu-actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 6px 0 2px; }\
#ejf-menu .ejf-btn { background: #2c333a; color: #e6e6e6; border: 1px solid #3a434d; border-radius: 5px; padding: 6px 10px; cursor: pointer; font-size: 12px; }\
#ejf-menu .ejf-btn:hover { background: #343c44; border-color: #4c9aff; }\
#ejf-menu .ejf-menu-status { color: #9aa6b2; font-size: 11px; padding: 8px 0 0; }',

    _injectCss: function () {
        if (!EJF_SD.menu._cssInjected) { GM_addStyle(EJF_SD.menu.css); EJF_SD.menu._cssInjected = true; }
    },

    isOpen: function () { return !!document.getElementById('ejf-menu-overlay'); },

    close: function () {
        var o = document.getElementById('ejf-menu-overlay');
        if (o && o.parentNode) { o.parentNode.removeChild(o); }
        if (EJF_SD.menu._esc) { document.removeEventListener('keydown', EJF_SD.menu._esc); EJF_SD.menu._esc = null; }
    },

    // Open (toggle): a second click of the menu command closes it again.
    open: function () {
        if (EJF_SD.menu.isOpen()) { EJF_SD.menu.close(); return; }
        EJF_SD.menu._injectCss();
        var $overlay = $('<div id="ejf-menu-overlay"></div>');
        $overlay.on('click', function (e) { if (e.target === this) { EJF_SD.menu.close(); } });   // backdrop click
        $('<div id="ejf-menu"></div>').appendTo($overlay);
        $overlay.appendTo(document.body);
        EJF_SD.menu._esc = function (e) { if (e.key === 'Escape') { EJF_SD.menu.close(); } };
        document.addEventListener('keydown', EJF_SD.menu._esc);
        EJF_SD.menu.render();
    },

    // A label + on/off switch row. `fn` is the existing toggle* function (which flips + persists the setting
    // and calls refreshMenu() -> render(), so the switch updates itself).
    _toggleRow: function (label, isOn, fn) {
        var $row = $('<div class="ejf-menu-row"></div>');
        $('<span class="lbl"></span>').text(label).appendTo($row);
        var $sw = $('<div class="ejf-sw"><span class="knob"></span></div>');
        if (isOn) { $sw.addClass('on'); }
        $sw.on('click', function () { try { fn(); } catch (e) { /* swallow */ } });
        $row.append($sw);
        return $row;
    },

    render: function () {
        var $p = $('#ejf-menu');
        if (!$p.length) { return; }
        $p.empty();

        var $head = $('<div class="ejf-menu-head"><h2>Enhanced Jira</h2></div>');
        $('<span class="ejf-menu-x" title="Close (Esc)">×</span>').on('click', EJF_SD.menu.close).appendTo($head);
        $p.append($head);

        // ---- Features ----
        var $feat = $('<div class="ejf-menu-sect"></div>');
        $('<h3>Features</h3>').appendTo($feat);
        $feat.append(EJF_SD.menu._toggleRow('Log Parser', !!savedVariables[1][1], toggleParser));
        $feat.append(EJF_SD.menu._toggleRow('Custom Scrollbar', !!savedVariables[2][1], toggleScrollbar));
        $feat.append(EJF_SD.menu._toggleRow('Extra Buttons', !!savedVariables[4][1], toggleButtons));
        $feat.append(EJF_SD.menu._toggleRow('Triage Assistant (Beta)', !!savedVariables[5][1], toggleSimilarDefects));
        $p.append($feat);

        // ---- Triage Assistant (only when enabled) ----
        if (savedVariables[5][1]) {
            var $ta = $('<div class="ejf-menu-sect"></div>');
            $('<h3>Triage Assistant</h3>').appendTo($ta);

            var $actions = $('<div class="ejf-menu-actions"></div>');
            $('<button class="ejf-btn">Sync defects now</button>')
                .on('click', function () { EJF_SD.menu.close(); EJF_SD.sync.syncNow(); }).appendTo($actions);
            $('<button class="ejf-btn">Sync bug reports now</button>')
                .on('click', function () { EJF_SD.menu.close(); EJF_SD.sync.syncEbrNow(); }).appendTo($actions);
            $('<button class="ejf-btn">Rebuild defect DB</button>')
                .on('click', function () { EJF_SD.menu.close(); EJF_SD.sync.rebuild(); }).appendTo($actions);
            $('<button class="ejf-btn">Rebuild BR DB</button>')
                .on('click', function () { EJF_SD.menu.close(); EJF_SD.sync.rebuildEbr(); }).appendTo($actions);
            $('<button class="ejf-btn">Exception clusters</button>')
                .on('click', function () { EJF_SD.logsig.openClustersView(); }).appendTo($actions);
            $ta.append($actions);

            // Panel style (integrated sidebar vs floating box). EJF_SD.ui.toggleStyle() re-mounts in place.
            var sidebarOn = (typeof EJF_SD !== 'undefined' && EJF_SD.ui.mode() === 'sidebar');
            var $styleRow = $('<div class="ejf-menu-row"></div>');
            $('<span class="lbl">Panel style</span>')
                .append($('<span class="sub"></span>').text('Currently: ' + (sidebarOn ? 'Sidebar (integrated)' : 'Floating (draggable box)')))
                .appendTo($styleRow);
            $('<button class="ejf-btn"></button>').text(sidebarOn ? 'Switch to floating' : 'Switch to sidebar')
                .on('click', function () { EJF_SD.menu.close(); EJF_SD.ui.toggleStyle(); }).appendTo($styleRow);
            $ta.append($styleRow);

            // Embedding backend (GPU vs CPU). Same flags toggleEmbedBackend() reads/writes; it reloads.
            var gpuOn = (typeof GM_getValue !== 'function') || (GM_getValue('sdTryWebgpu', true) && !GM_getValue('sdForceCpu', false));
            var $row = $('<div class="ejf-menu-row"></div>');
            $('<span class="lbl">Embedding backend</span>')
                .append($('<span class="sub"></span>').text('Currently: ' + (gpuOn ? 'GPU (faster, experimental)' : 'CPU (stable)')))
                .appendTo($row);
            $('<button class="ejf-btn"></button>').text(gpuOn ? 'Switch to CPU' : 'Switch to GPU')
                .on('click', function () { toggleEmbedBackend(); }).appendTo($row);
            $ta.append($row);

            // Live "what's indexed" status (defects + open reports) + when each local DB was last built,
            // filled in async.
            var $status = $('<div class="ejf-menu-status">Loading database status…</div>').appendTo($ta);
            EJF_SD.db.countDefectsOnly().then(function (d) {
                return EJF_SD.db.countEbr().then(function (e) {
                    return EJF_SD.db.getMeta('dbBuiltAtDefects').then(function (bd) {
                        return EJF_SD.db.getMeta('dbBuiltAtEbr').then(function (be) {
                            if (!document.getElementById('ejf-menu')) { return; }
                            var line = d + ' defects · ' + e + ' open bug reports indexed locally';
                            var built = [];
                            if (bd) { built.push('defects ' + EJF_SD.util.fmtDate(bd)); }
                            if (be) { built.push('reports ' + EJF_SD.util.fmtDate(be)); }
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
// EJF_SD.DATA_VERSION whenever it is built from scratch (fullSync / fullSyncEbr - which a manual rebuild also
// routes through). On load, if a POPULATED dataset is stamped BELOW the current DATA_VERSION - or carries no
// stamp at all, i.e. it was built before this mechanism shipped - we transparently re-fetch just that dataset
// once (refetchDefects / refetchEbr), which backfills the new field without dropping embeddings. Brand-new /
// empty DBs need nothing: their first full build stamps the current version.
EJF_SD.migrate = {
    _done: false,
    run: function () {
        if (EJF_SD.migrate._done) { return; }            // once per session
        EJF_SD.migrate._done = true;
        if (!savedVariables[5][1]) { return; }            // Triage Assistant off -> nothing to migrate
        EJF_SD.db.countDefectsOnly().then(function (nDef) {
            return EJF_SD.db.getMeta('dataVersionDefects').then(function (dv) {
                var defStale = nDef > 0 && (Number(dv) || 0) < EJF_SD.DATA_VERSION;
                return EJF_SD.db.countEbr().then(function (nEbr) {
                    return EJF_SD.db.getMeta('dataVersionEbr').then(function (ev) {
                        var ebrStale = nEbr > 0 && (Number(ev) || 0) < EJF_SD.DATA_VERSION;
                        if (!defStale && !ebrStale) { return; }
                        console.log('[EJF-SD] local DB schema out of date (defects v' + (Number(dv) || 0) +
                            ', reports v' + (Number(ev) || 0) + ' < v' + EJF_SD.DATA_VERSION +
                            ') - auto re-fetching to backfill new fields');
                        // Sequential: each refetch is single-flight (the `running` guard), so chain them.
                        var chain = Promise.resolve();
                        if (defStale) { chain = chain.then(function () { return EJF_SD.sync.refetchDefects(); }); }
                        if (ebrStale) { chain = chain.then(function () { return EJF_SD.sync.refetchEbr(); }); }
                        return chain;
                    });
                });
            });
        }).catch(function (e) { console.log('[EJF-SD] migration check skipped:', e && e.message || e); });
    }
};


/* ---- background auto-sync scheduler (Phase 3) ---- */
// Keeps the local DB fresh without the user clicking "Sync defects now": auto-initializes both datasets on
// first run and then runs incremental catch-ups roughly every INTERVAL_MS. A best-effort cross-tab lease
// (GM storage) keeps multiple open Jira tabs from all syncing at once; the in-tab `running` flag prevents
// overlap within a tab. We POLL on a short timer (POLL_MS) and let the persisted recentlySynced() gate
// decide when INTERVAL_MS has actually elapsed - polling far more often than the gate avoids the phase
// collision you'd get if the timer period equalled the gate window (which skipped every other run).
EJF_SD.sched = {
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
        if (typeof GM_getValue !== 'function') { return false; }
        var last = 0;
        try { last = GM_getValue(EJF_SD.sched.LAST_SYNC_KEY, 0) || 0; } catch (e) { last = 0; }
        return !!last && (Date.now() - last) < EJF_SD.sched.INTERVAL_MS;
    },

    // Stamp "a sync just completed" so recentlySynced() starts the 30-minute clock. Called from every sync
    // completion path (autoSync / syncNow / rebuild).
    markSynced: function () {
        try { if (typeof GM_setValue === 'function') { GM_setValue(EJF_SD.sched.LAST_SYNC_KEY, Date.now()); } } catch (e) { /* ignore */ }
        // If a log is open, re-match it against the freshly-synced defect index so a newly-indexed defect
        // (e.g. one you just created) appears in the "Defects in log" panel without reopening the log.
        try { if (EJF_SD.logsig) { EJF_SD.logsig.rematch(); } } catch (e2) { /* ignore */ }
    },

    // Best-effort single-syncer lease across tabs. Returns true if this tab may sync now. Not perfectly
    // race-free, but a rare double-run is harmless (bulkPut is idempotent and embeddings are preserved).
    _acquireLease: function () {
        if (typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function') { return true; }
        var l = null;
        try { l = GM_getValue(EJF_SD.sched.LEASE_KEY, null); } catch (e) { return true; }
        var now = Date.now();
        if (!l || !l.ts || (now - l.ts) > EJF_SD.sched.LEASE_TTL_MS || l.tabId === EJF_SD.sched.tabId) {
            try { GM_setValue(EJF_SD.sched.LEASE_KEY, { tabId: EJF_SD.sched.tabId, ts: now }); } catch (e2) { /* ignore */ }
            return true;
        }
        return false;
    },

    tick: function () {
        if (!savedVariables[5][1]) { return; }            // feature disabled
        if (EJF_SD.sched.recentlySynced()) { return; }    // a sync ran < INTERVAL_MS ago (persisted) - don't re-fetch on reload
        if (!EJF_SD.sched._acquireLease()) { return; }    // another tab is the syncer right now
        EJF_SD.sync.autoSync();
    },

    start: function () {
        if (EJF_SD.sched._timer) { return; }
        setTimeout(function () {
            try { EJF_SD.sched.tick(); } catch (e) { /* swallow */ }
            // Poll every POLL_MS (≪ INTERVAL_MS). tick() itself only acts once recentlySynced() reports that
            // INTERVAL_MS has elapsed, so this reliably fires ~every 30 min instead of skipping windows.
            EJF_SD.sched._timer = setInterval(function () {
                try { EJF_SD.sched.tick(); } catch (e) { /* swallow */ }
            }, EJF_SD.sched.POLL_MS);
        }, EJF_SD.sched.STARTUP_DELAY_MS);
    }
};


/* ---- init: watch the DOM and (re)inject the panel across Atlassian's React re-renders / SPA nav ---- */
(function () {
    if (!window.indexedDB) { return; }   // feature unavailable in this environment
    var scheduled = false;
    var observer = new MutationObserver(function () {
        if (scheduled) { return; }
        scheduled = true;
        setTimeout(function () {
            scheduled = false;
            try { EJF_SD.ui.ensure(); } catch (e) { /* swallow */ }
            try { EJF_SD.ui.updateVisibility(); } catch (e2) { /* swallow */ }   // hide while an attachment viewer is open
            try { EJF_SD.logsig.updateVisibility(); } catch (e3) { /* swallow */ }   // drop the "Defects in log" panel once the log viewer closes
        }, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // also try once on load in case the breadcrumb is already present
    setTimeout(function () { try { EJF_SD.ui.ensure(); } catch (e) { /* swallow */ } }, 1500);
    // one-time data-schema migration: re-fetch a local DB that predates a stored-field change. Runs before
    // the scheduler's startup tick (below) so its full re-fetch grabs the single-flight lock first.
    setTimeout(function () { try { EJF_SD.migrate.run(); } catch (e) { /* swallow */ } }, 4000);
    // start the periodic background catch-up sync
    EJF_SD.sched.start();
})();
