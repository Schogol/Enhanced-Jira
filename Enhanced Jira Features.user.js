// ==UserScript==
// @name        Enhanced Jira Features
// @version     2.8.3
// @author      ISD BH Schogol, ISD Tulwar
// @description Adds a Translate, Assign to GM, Convert to Defect and Close button to Jira, parses Log Files submitted from the EVE client, and suggests similar existing defects on bug reports
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
// ==/UserScript==
/* global $ */



// Creating various variables which we use later on
var rows, oc, lc, pdm, pdmdata, driverAge = "unknown", menu_parser, menu_scrollbar, menu_dropdowns, menu_buttons, menu_darkmode, menu_similarDefects, menu_sdSync, menu_sdRebuild, menu_sdBackend;


// Current Date
var today = new Date();


// Array which contains the locally saved values for a couple of variables
var savedVariables = [["key",""], ["parser", ""], ["scrollbar", ""], ["dropdowns", ""], ["buttons", ""], ["similarDefects", ""]];


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


// Listener which triggers when the locally saved "dropdowns" value is changed. If the new value is false we remove functionality of the LinkedIssue dropdowns. If the new value is true we add the dropdowns to LinkedIssues.
GM_addValueChangeListener("dropdowns", function(key, oldValue, newValue, remote) {
    if (!newValue) {
        let reasons = ['duplicates', 'added to idea', 'blocks', 'is blocked by', 'clones', 'is cloned by', 'is duplicated by', 'has to be finished together with', 'has to be done before', 'has to be done after', 'earliest end is start of', 'start is earliest end of', 'has to be started together with', 'split to', 'split from', 'is parent of', 'is child of', 'is idea for', 'implements', 'is implemented by', 'merged from', 'merged into', 'reviews', 'is reviewed by', 'causes', 'is caused by', 'relates to']

        for (let i = 0; i < reasons.length; i++) {
            if ($('h3 > span:contains(' + reasons[i] + ')')) {
                $('h3 > span:contains(' + reasons[i] + ')').text(reasons[i]);
                $('h3 > span:contains(' + reasons[i] + ')').css('cursor', '');
                $('h3 > span:contains(' + reasons[i] + ')').parent().next().show();
                $('h3 > span:contains(' + reasons[i] + ')').off('click');
            }
        }
    } else {
        let reasons = ['duplicates', 'added to idea', 'blocks', 'is blocked by', 'clones', 'is cloned by', 'is duplicated by', 'has to be finished together with', 'has to be done before', 'has to be done after', 'earliest end is start of', 'start is earliest end of', 'has to be started together with', 'split to', 'split from', 'is parent of', 'is child of', 'is idea for', 'implements', 'is implemented by', 'merged from', 'merged into', 'reviews', 'is reviewed by', 'causes', 'is caused by', 'relates to']

        for (let i = 0; i < reasons.length; i++) {
            if ($('h3 > span:contains(' + reasons[i] + ')')) {
                let children = $('h3 > span:contains(' + reasons[i] + ')').parent().next().children().length;

                $('h3 > span:contains(' + reasons[i] + ')').text('> ' + reasons[i] + ' - '+ children +' elements');
                $('h3 > span:contains(' + reasons[i] + ')').css('cursor', 'pointer');
                $('h3 > span:contains(' + reasons[i] + ')').parent().next().toggle();
                $('h3 > span:contains(' + reasons[i] + ')').click(function() {
                    $(this).parent().next().toggle();
                    $(this).toggleText('> ' + reasons[i] + ' - '+ children +' elements', '⌄ ' + reasons[i] + ' - '+ children +' elements')
                });
            }
        }
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


// Check if the Translation API key is set. If it isn't then prompt for the user to input the key.
if (!savedVariables[0][1]) {
    savedVariables[0][1] = prompt (
        'Translation API key not set. Please enter the key:',
        ''
    );
    GM_setValue (savedVariables[0][0], savedVariables[0][1]);
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


// Add menu command that allows the Translation API key to be changed.
GM_registerMenuCommand ("Change Translation API Key", promptAndChangeStoredValue);


// Add menu command that will allow to toggle On/Off the Log Parser.
if (savedVariables[1][1]) {
    menu_parser = GM_registerMenuCommand ("Disable Log Parser", toggleParser);
}
else {
    menu_parser = GM_registerMenuCommand ("Enable Log Parser", toggleParser);
}



// Add menu command that will allow to toggle On/Off the custom scrollbar.
if (savedVariables[2][1]) {
    menu_scrollbar = GM_registerMenuCommand ("Disable Custom Scrollbar", toggleScrollbar);
}
else {
    menu_scrollbar = GM_registerMenuCommand ("Enable Custom Scrollbar", toggleScrollbar);
}



// Add menu command that will allow to toggle On/Off the dropdown lists on Linked Issues.
if (savedVariables[3][1]) {
    menu_dropdowns = GM_registerMenuCommand ("Disable Linked Issue Dropdowns", toggleDropdown);
}
else {
    menu_dropdowns = GM_registerMenuCommand ("Enable Linked Issue Dropdowns", toggleDropdown);
}



// Add menu command that will allow to toggle On/Off the extra buttons on bug reports.
if (savedVariables[4][1]) {
    menu_buttons = GM_registerMenuCommand ("Disable Extra Buttons", toggleButtons);
}
else {
    menu_buttons = GM_registerMenuCommand ("Enable Extra Buttons", toggleButtons);
}



// Add menu command that will allow to toggle On/Off the "Similar Defects" suggestions on bug reports.
if (savedVariables[5][1]) {
    menu_similarDefects = GM_registerMenuCommand ("Disable Similar Defects (Beta)", toggleSimilarDefects);
}
else {
    menu_similarDefects = GM_registerMenuCommand ("Enable Similar Defects (Beta)", toggleSimilarDefects);
}

// Action commands for the Similar Defects local database. Shown only while the feature is enabled, and
// managed by refreshMenu (registerSimilarDefectActions) so they survive the disable/re-enable cycle - if
// they were registered only once here they would be dropped when refreshMenu rebuilds the menu. The
// callbacks reference EJF_SD lazily, so it is fine that the namespace is defined later in the file.
registerSimilarDefectActions();



// Add menu command that will allow to toggle On/Off darkmode.
if ($('html[data-color-mode="dark"]')[0]) {
    menu_darkmode = GM_registerMenuCommand ("Disable Dark Mode", toggleDarkmode);
}
else {
    menu_darkmode = GM_registerMenuCommand ("Enable Dark Mode", toggleDarkmode);
};



// Function which prompts the user to input a value for the Translation API Key and saves it locally
function promptAndChangeStoredValue () {
    savedVariables[0][1] = prompt (
        'Change Translation API Key:',
        ''
    );
    GM_setValue (savedVariables[0][0], savedVariables[0][1]);
};


// (Re)register the Similar Defects action commands ("Sync defects now" / "Rebuild defect database").
// Idempotent: it clears any existing ones first, then adds them only while the feature is enabled. Called
// from the initial menu setup and from refreshMenu, so the commands correctly come back after a re-enable.
function registerSimilarDefectActions() {
    if (menu_sdSync) { GM_unregisterMenuCommand(menu_sdSync); menu_sdSync = null; }
    if (menu_sdRebuild) { GM_unregisterMenuCommand(menu_sdRebuild); menu_sdRebuild = null; }
    if (menu_sdBackend) { GM_unregisterMenuCommand(menu_sdBackend); menu_sdBackend = null; }
    if (savedVariables[5][1]) {
        menu_sdSync = GM_registerMenuCommand ("Sync defects now", function () { EJF_SD.sync.syncNow(); });
        menu_sdRebuild = GM_registerMenuCommand ("Rebuild defect database", function () { EJF_SD.sync.rebuild(); });
        // Label reflects what the toggle will switch TO. GPU is the default (sdTryWebgpu defaults to true) and
        // is "on" unless the user opted out OR the sticky "GPU unstable" lock got set after a device loss.
        var gpuOn = (typeof GM_getValue !== 'function') || (GM_getValue('sdTryWebgpu', true) && !GM_getValue('sdForceCpu', false));
        menu_sdBackend = GM_registerMenuCommand(
            gpuOn ? "Embedding backend: switch to CPU (stable)" : "Embedding backend: switch to GPU (faster, experimental)",
            toggleEmbedBackend
        );
    }
}


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


// Function which refreshes the Tampermonkey menu
function refreshMenu() {
    GM_unregisterMenuCommand(menu_parser);
    GM_unregisterMenuCommand(menu_scrollbar);
    GM_unregisterMenuCommand(menu_dropdowns);
    GM_unregisterMenuCommand(menu_buttons);
    GM_unregisterMenuCommand(menu_similarDefects);
    GM_unregisterMenuCommand(menu_darkmode);

    if (savedVariables[1][1]) {
        menu_parser = GM_registerMenuCommand ("Disable Log Parser", toggleParser);
    }
    else {
        menu_parser = GM_registerMenuCommand ("Enable Log Parser", toggleParser);
    }

    if (savedVariables[2][1]) {
        menu_scrollbar = GM_registerMenuCommand ("Disable Custom Scrollbar", toggleScrollbar);
    }
    else {
        menu_scrollbar = GM_registerMenuCommand ("Enable Custom Scrollbar", toggleScrollbar);
    }

    if (savedVariables[3][1]) {
        menu_dropdowns = GM_registerMenuCommand ("Disable Linked Issue Dropdowns", toggleDropdown);
    }
    else {
        menu_dropdowns = GM_registerMenuCommand ("Enable Linked Issue Dropdowns", toggleDropdown);
    }

    if (savedVariables[4][1]) {
        menu_buttons = GM_registerMenuCommand ("Disable Extra Buttons", toggleButtons);
    }
    else {
        menu_buttons = GM_registerMenuCommand ("Enable Extra Buttons", toggleButtons);
    }

    if (savedVariables[5][1]) {
        menu_similarDefects = GM_registerMenuCommand ("Disable Similar Defects (Beta)", toggleSimilarDefects);
    }
    else {
        menu_similarDefects = GM_registerMenuCommand ("Enable Similar Defects (Beta)", toggleSimilarDefects);
    }

    // Re-add (or remove) the Sync / Rebuild action commands to match the toggle state.
    registerSimilarDefectActions();

    if ($('html[data-color-mode="dark"]')[0]) {
        menu_darkmode = GM_registerMenuCommand ("Disable Dark Mode", toggleDarkmode);
    }
    else {
        menu_darkmode = GM_registerMenuCommand ("Enable Dark Mode", toggleDarkmode);
    }
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


// Function which toggles between true and false for the dropdowns variable and saves it locally
function toggleDropdown() {
    savedVariables[3][1] = savedVariables[3][1] ? false : true;
    GM_setValue (savedVariables[3][0], savedVariables[3][1]);
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
        if (typeof EJF_SD !== 'undefined') { EJF_SD.ui.currentKey = null; }
    } else if (typeof EJF_SD !== 'undefined') {
        EJF_SD.ui.ensure();
    }
    refreshMenu();
};


// Function which toggles darkmode on / off by sending the nescessary PUT command to the atlassian server to change the dark mode setting. It then reloads the page
function toggleDarkmode() {
    if ($('html[data-color-mode="dark"]')[0]) {
        $('input[type=checkbox]').prop('checked', false);
        $.ajax({
            url: 'https://fenriscreations.atlassian.net/rest/api/3/mypreferences?key=jira.user.theme.preference',
            type: 'PUT',
            contentType: 'application/json',
            charset: 'utf-8',
            Accept: 'application/json,text/javascript,*/*',
            data: '{"value":"light"}',
        })
    } else {
        $('input[type=checkbox]').prop('checked', true);
        $.ajax({
            url: 'https://fenriscreations.atlassian.net/rest/api/3/mypreferences?key=jira.user.theme.preference',
            type: 'PUT',
            contentType: 'application/json',
            charset: 'utf-8',
            Accept: 'application/json,text/javascript,*/*',
            data: '{"value":"dark"}',
        })
    }
    refreshMenu();
    window.location.reload(false)
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
    }, 200);
});
ejfButtonObserver.observe(document.body, { childList: true, subtree: true });


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
    'style="margin-left: 8px; width: fit-content; padding: 6px 12px; white-space: nowrap; display: inline-flex; align-items: center;">' +
    '<span class="' + innerSpanClass + '"></span>' +
    '<span style="font-size: 13px;">Translate</span>' +
    '</button>'
    );
    $('button[data-testid="issue-view-foundation.quick-add.quick-add-items-compact.apps-button-dropdown--trigger"]').after(translateButton);
    }

    // When the translate button is clicked we send the Issue title, description and reproduction steps to the Google translate API and change the original content to what we receive back from the API
    $("#translateButton").click(function () {
        $.ajax({
            url: 'https://translation.googleapis.com/language/translate/v2?key=' + savedVariables[0][1],
            type: 'POST',
            contentType: 'application/json',
            charset: 'utf-8',

            // The regex might be a bit janky but it removes some unneccessary spaces in the text which we send to the API.
            // By changing the "target:" attribute we could chose a different language than english if needed
            data: '{"q":"'+ $("h1[data-testid='issue.views.issue-base.foundation.summary.heading']").text().replace(/"/g,'').replace(/ {2,}/g,' ')+'", "q":"'+ $("div[data-component-selector='jira-issue-view-rich-text-inline-edit-view-container']").children().eq(0).text().replace(/"/g,'').replace(/ {2,}/g,' ')+'", "q":"'+ $("div[data-component-selector='jira-issue-view-rich-text-inline-edit-view-container']").children().eq(1).text().replace(/"/g,'').replace(/ {2,}/g,' ')+'", "target":"en", "format":"text"}',

            // When we receive a translation back from the API we replace the original Title, Description and Repro-Steps with the translation we get from Google.
            success: function (data) {
                $("h1[data-testid='issue.views.issue-base.foundation.summary.heading']").text(data.data.translations[0].translatedText);
                $("div[data-component-selector='jira-issue-view-rich-text-inline-edit-view-container']").children().eq(1).replaceWith(data.data.translations[2].translatedText.replace(/\n\n/g, '<br><br>'));
                $("div[data-component-selector='jira-issue-view-rich-text-inline-edit-view-container']").children().eq(0).replaceWith(data.data.translations[1].translatedText.replace(/\n/g, '<br><br>'));
            },

            // If we get an Error from the Google API then we annoy the user by telling them that it failed and to check their Dev Console for errors
            error: function(data){
                console.log(JSON.stringify(data));
                alert("Cannot get translation. Check Console for errors and report issues to Schogol :). \r\nMake sure you have entered the correct key.");
            }
        })
    });


    // Create GM Button
if ($('#GMButton').length === 0) {
  var GMButton = $(
    '<button id="GMButton" aria-label="GMButton" class="' + buttonClass + '" type="button" tabindex="1" ' +
    'style="margin-left: 8px; width: fit-content; padding: 6px 12px; white-space: nowrap; display: inline-flex; align-items: center;">' +
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
    'style="margin-left: 8px; width: fit-content; padding: 6px 12px; white-space: nowrap; display: inline-flex; align-items: center;">' +
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
    'style="margin-left: 8px; width: fit-content; padding: 6px 12px; white-space: nowrap; display: inline-flex; align-items: center;">' +
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


// When we detect the "Linked Issues" header on the page then we run the createDropdowns function which creates dropdown lists for all linked issues
var linkedIssues = 'h2:contains(Linked issue)';
waitForKeyElements (linkedIssues, createDropdowns);


// Function which creates dropdown lists for all different types of linked issues instead of listing them all by default
function createDropdowns() {
    let reasons = ['duplicates', 'added to idea', 'blocks', 'is blocked by', 'clones', 'is cloned by', 'is duplicated by', 'has to be finished together with', 'has to be done before', 'has to be done after', 'earliest end is start of', 'start is earliest end of', 'has to be started together with', 'split to', 'split from', 'is parent of', 'is child of', 'is idea for', 'implements', 'is implemented by', 'merged from', 'merged into', 'reviews', 'is reviewed by', 'causes', 'is caused by', 'relates to']

    if (savedVariables[3][1]) {
        for (let i = 0; i < reasons.length; i++) {
            if ($('h3 > span:contains(' + reasons[i] + ')')) {
                let children = $('h3 > span:contains(' + reasons[i] + ')').parent().next().children().length;
                $('h3 > span:contains(' + reasons[i] + ')').text('> ' + reasons[i] + ' - '+ children +' elements');
                $('h3 > span:contains(' + reasons[i] + ')').css('cursor', 'pointer');
                $('h3 > span:contains(' + reasons[i] + ')').parent().next().toggle();
                $('h3 > span:contains(' + reasons[i] + ')').click(function() {
                    $(this).parent().next().toggle();
                    $(this).toggleText('> ' + reasons[i] + ' - '+ children +' elements', '⌄ ' + reasons[i] + ' - '+ children +' elements')
                });
            }
        }
    };
}


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
        $('#table').css({ position: 'fixed', top: '85px', bottom: '0', left: '0', width: '100%' });
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


// HTML for the darkMode Switch
var darkModeSwitch = `
    <span>
      <input type="checkbox" class="checkbox" id="checkbox">
      <label for="checkbox" class="checkbox-label">
        <svg viewBox="0 -150 1000 800">
  <path d="M223.5 32C100 32 0 132.3 0 256S100 480 223.5 480c60.6 0 115.5-24.2 155.8-63.4c5-4.9 6.3-12.5 3.1-18.7s-10.1-9.7-17-8.5c-9.8 1.7-19.8 2.6-30.1 2.6c-96.9 0-175.5-78.8-175.5-176c0-65.8 36-123.1 89.3-153.3c6.1-3.5 9.2-10.5 7.7-17.3s-7.3-11.9-14.3-12.5c-6.3-.5-12.6-.8-19-.8z" style="fill: rgb(241, 196, 15);"></path>
</svg>
<svg viewBox="-350 -150 1000 800">
  <path d="M361.5 1.2c5 2.1 8.6 6.6 9.6 11.9L391 121l107.9 19.8c5.3 1 9.8 4.6 11.9 9.6s1.5 10.7-1.6 15.2L446.9 256l62.3 90.3c3.1 4.5 3.7 10.2 1.6 15.2s-6.6 8.6-11.9 9.6L391 391 371.1 498.9c-1 5.3-4.6 9.8-9.6 11.9s-10.7 1.5-15.2-1.6L256 446.9l-90.3 62.3c-4.5 3.1-10.2 3.7-15.2 1.6s-8.6-6.6-9.6-11.9L121 391 13.1 371.1c-5.3-1-9.8-4.6-11.9-9.6s-1.5-10.7 1.6-15.2L65.1 256 2.8 165.7c-3.1-4.5-3.7-10.2-1.6-15.2s6.6-8.6 11.9-9.6L121 121 140.9 13.1c1-5.3 4.6-9.8 9.6-11.9s10.7-1.5 15.2 1.6L256 65.1 346.3 2.8c4.5-3.1 10.2-3.7 15.2-1.6zM160 256a96 96 0 1 1 192 0 96 96 0 1 1 -192 0zm224 0a128 128 0 1 0 -256 0 128 128 0 1 0 256 0z" style="fill: rgb(243, 156, 18);"></path>
</svg>
        <span class="ball"></span>
      </label>
    </span>
    `

// CSS for the darkMode Switch
var darkModeSwitchCss = `
    .checkbox {
      opacity: 0;
      position: absolute;
    }

    .checkbox-label {
      box-sizing: border-box;
      background-color: #323232;
      width: 50px;
      height: 26px;
      border-radius: 50px;
      position: relative;
      padding: 5px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .fa-moon {
      color: #f1c40f;
    }

    .fa-sun {
      color: #f39c12;
    }

    .checkbox-label .ball {
      background-color: #fff;
      width: 22px;
      height: 22px;
      position: absolute;
      left: 2px;
      top: 2px;
      border-radius: 50%;
      transition: transform 0.2s linear;
    }

    .checkbox:checked + .checkbox-label .ball {
      transform: translateX(24px);
    }
`


// We wait until the searchbar is loaded before running the function addDarkmodeToggle
var searchbar = 'input[data-test-id="search-dialog-input"';
waitForKeyElements(searchbar, addDarkmodeToggle);


// This adds the CSS and Button (An input checkbox box) to the right of the search box. If the darkmode is enabled then we check the checkbox
function addDarkmodeToggle() {
  GM_addStyle(darkModeSwitchCss);

  const target = $('[data-test-id="ak-spotlight-target-global-create-spotlight"]');

  if (
    target.length &&
    ($('html[data-color-mode="dark"]').length || $('html[data-color-mode="light"]').length)
  ) {
    const button = target.find('button[data-testid="atlassian-navigation--create-button"]');
    const buttonContainer = button.parent();

    if (buttonContainer.length && $('#darkModeToggle').length === 0) {
      // Set the parent container to flex to align items horizontally
      buttonContainer.parent().css({
        display: 'flex',
        'align-items': 'center'
      });

      // Create toggle wrapper with margin-left and flex alignment
      const toggleWrapper = $('<div id="darkModeToggle" style="margin-left: 12px; display: flex; align-items: center;"></div>')
        .html(darkModeSwitch);

      // Insert the toggle right after the button container
      buttonContainer.after(toggleWrapper);

      // Set initial checkbox state based on current color mode
      if ($('html[data-color-mode="dark"]').length) {
        $('#checkbox').prop('checked', true);
      }

      // Attach click event for toggling dark mode
      $('#checkbox').on('click', toggleDarkmode);
    }
  }
}

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
    FIELDS: ['summary', 'description', 'status', 'resolution', 'components', 'updated', 'project'],
    DB_NAME: 'EJF_SimilarDefects',
    DB_VERSION: 1,
    PAGE_SIZE: 100,
    PAGE_DELAY_MS: 250,                            // polite gap between search pages
    NEAR_LIMIT_DELAY_MS: 3000,                     // back off harder when the rate-limit budget is low
    MAX_RETRIES: 5,
    TOP_N: 8,
    MODEL_VERSION: 'gte-small-v3'                   // embedding model tag; bump to force a full re-embed
                                                    // (v1 = NaN from fp16; v2 = fp32; v3 = boilerplate-stripped text)
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

    delay: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
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

    clearDefects: function () {
        return EJF_SD.db.open().then(function () {
            return new Promise(function (resolve, reject) {
                var r = EJF_SD.db._store('defects', 'readwrite').clear();
                r.onsuccess = function () { resolve(); };
                r.onerror = function (e) { reject(e.target.error); };
            });
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
            components: components,
            updated: f.updated || '',
            embedding: null,
            embeddingModelVersion: null,
            textHash: EJF_SD.util.hash(summary + '\n' + description)
        };
    },

    // Page through /search/jql for a given jql, storing each page. Resumable via meta.resumeToken.
    // opts: { startToken, startHighWater }
    _run: function (jql, opts) {
        opts = opts || {};
        var token = opts.startToken || null;
        var pages = 0, stored = 0;
        var maxUpdated = opts.startHighWater || '';

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
                    return EJF_SD.db.bulkPut(merged);
                }).then(function () {
                    stored += recs.length;
                    pages++;
                    EJF_SD.rank._dirty = true;
                    EJF_SD.rank._dirtyVec = true;
                    var nextToken = data.nextPageToken || null;
                    // Persist progress so a reload mid-sync resumes rather than restarting.
                    return EJF_SD.db.setMeta('resumeToken', (data.isLast || !nextToken) ? null : nextToken)
                        .then(function () { return EJF_SD.db.setMeta('lastSyncHighWater', maxUpdated); })
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
                    return EJF_SD.db.setMeta('lastFullSyncAt', new Date().toISOString())
                        .then(function () { return EJF_SD.db.setMeta('modelVersion', EJF_SD.MODEL_VERSION); })
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
        return EJF_SD.db.countDefects().then(function (n) {
            return n === 0 ? EJF_SD.sync.fullSync() : EJF_SD.sync.incrementalSync();
        }).then(function (res) {
            return EJF_SD.db.countDefects().then(function (total) {
                EJF_SD.sync.running = false;
                EJF_SD.ui.toast('Defect sync complete – ' + total + ' defects in local DB.');
                EJF_SD.ui.setStatus(total + ' defects in database');
                if (EJF_SD.ui.currentKey) { EJF_SD.ui.render(EJF_SD.ui.currentKey); }
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
                return EJF_SD.db.countDefects().then(function (total) {
                    EJF_SD.sync.running = false;
                    EJF_SD.ui.toast('Rebuild complete – ' + total + ' defects.');
                    if (EJF_SD.ui.currentKey) { EJF_SD.ui.render(EJF_SD.ui.currentKey); }
                    EJF_SD.embed.prepare(true);   // re-embed everything in the background
                });
            })
            .catch(function (e) {
                EJF_SD.sync.running = false;
                EJF_SD.ui.setStatus('Rebuild error: ' + (e && e.message || e));
                alert('Rebuild failed: ' + (e && e.message || e));
            });
    },

    // Quiet background catch-up used by the auto-sync scheduler: incremental only (never the big initial
    // build - that stays a deliberate manual action, so we skip an empty DB), no start/finish toasts, and it
    // re-embeds + refreshes the open panel only when it actually fetched changed issues.
    autoSync: function () {
        if (EJF_SD.sync.running) { return Promise.resolve(); }
        EJF_SD.sync.running = true;
        return EJF_SD.db.countDefects().then(function (n) {
            if (!n) { EJF_SD.sync.running = false; return; }   // don't auto-trigger the initial full sync
            return EJF_SD.sync.incrementalSync().then(function (res) {
                EJF_SD.sync.running = false;
                var stored = (res && res.stored) || 0;
                console.log('[EJF-SD] auto-sync done (' + stored + ' fetched)');
                return EJF_SD.db.setMeta('lastAutoSyncAt', new Date().toISOString()).then(function () {
                    if (stored > 0) {
                        EJF_SD.embed.prepare(true);   // embed any new/changed defects
                        if (EJF_SD.ui.currentKey) { EJF_SD.ui.render(EJF_SD.ui.currentKey); }
                    }
                    return res;
                });
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
                var toks = EJF_SD.rank._tokenize(EJF_SD.util.cleanForCompare(rec.summary, rec.description));
                var tf = {}, seen = {};
                for (var j = 0; j < toks.length; j++) {
                    var tk = toks[j];
                    tf[tk] = (tf[tk] || 0) + 1;
                    if (!seen[tk]) { df[tk] = (df[tk] || 0) + 1; seen[tk] = true; }
                }
                totalLen += toks.length;
                docs.push({ key: rec.key, project: rec.project, summary: rec.summary, status: rec.status, resolution: rec.resolution, tf: tf, len: toks.length });
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
                if (score > 0) { scored.push({ key: doc.key, project: doc.project, summary: doc.summary, status: doc.status, resolution: doc.resolution, score: score }); }
            }
            scored.sort(function (a, c) { return c.score - a.score; });
            return scored.slice(0, limit || EJF_SD.TOP_N);
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
                if (recs[i].embedding && recs[i].embeddingModelVersion === EJF_SD.MODEL_VERSION) { curVer++; }
                else { todo.push(recs[i]); }
            }
            console.log('[EJF-SD] embed pass: ' + todo.length + ' to embed, ' + curVer + ' already at ' +
                EJF_SD.MODEL_VERSION + ' (of ' + recs.length + ' total, backend ' + EJF_SD.embed.backend + ')');
            if (!todo.length) { EJF_SD.ui.setStatus('Embeddings up to date (' + curVer + ')'); return; }
            EJF_SD.ui.toast('Embedding ' + todo.length + ' defects locally…');
            var idx = 0, gpuRetries = 0;
            function nextBatch() {
                if (idx >= todo.length) { console.log('[EJF-SD] embed pass complete (' + todo.length + ' embedded)'); EJF_SD.rank._dirtyVec = true; return Promise.resolve(); }
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
            if (!n) { return; }   // nothing synced yet - don't download a model for an empty DB
            return EJF_SD.embed.embedPass().then(function () {
                EJF_SD.embed._prepared = true;
                EJF_SD.rank._dirtyVec = true;
                if (EJF_SD.ui.currentKey) { EJF_SD.ui.render(EJF_SD.ui.currentKey); }
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
            if (r.embedding && r.embeddingModelVersion === EJF_SD.MODEL_VERSION) {
                docs.push({ key: r.key, project: r.project, summary: r.summary, status: r.status, resolution: r.resolution, vec: r.embedding });
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
                status: docs[d].status, resolution: docs[d].resolution,
                score: sc
            });
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
EJF_SD.rank.suggestBest = function (text, key) {
    function keywordOnly() {
        return EJF_SD.rank.suggest(text, key, EJF_SD.TOP_N).then(function (list) {
            var top = (list[0] && list[0].score) || 0;
            for (var i = 0; i < list.length; i++) { list[i].pct = top > 0 ? Math.round(list[i].score / top * 100) : 0; }
            return { mode: 'Keyword', results: list };
        });
    }
    if (EJF_SD.embed.unavailable || !EJF_SD.embed.ready) {
        EJF_SD.embed.prepare();   // warm up the model in the background; show keyword results meanwhile
        return keywordOnly();
    }
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
                        rrf: rrf[k], pct: hasCos ? Math.round(Math.max(0, Math.min(1, cosByKey[k])) * 100) : 0
                    };
                });
                // RRF decides WHICH results make the cut (so strong keyword hits aren't lost even when their
                // cosine is middling) - then present those top-N sorted by the displayed similarity % so the
                // panel reads high-to-low, matching what the user sees.
                out.sort(function (a, c2) { return c2.rrf - a.rrf; });
                var topN = out.slice(0, EJF_SD.TOP_N);
                topN.sort(function (a, c2) { return c2.pct - a.pct; });
                return { mode: 'Hybrid', results: topN };
            });
        });
    }).catch(function () {
        // A query-time embed failed (e.g. a WebGPU device loss while viewing a report). We do NOT auto-switch
        // to CPU - that's the user's choice via the menu. Just drop the (possibly dead) pipeline so the next
        // query rebuilds on the same backend, and show keyword results for now.
        EJF_SD.embed._resetPipe();
        return keywordOnly();
    });
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
.ejf-sd-sum { margin-top: 2px; color: #e6e6e6; }\
.ejf-sd-meta { margin-top: 2px; color: #7a8694; font-size: 10px; }\
#ejf-sd-panel.collapsed #ejf-sd-status, #ejf-sd-panel.collapsed #ejf-sd-list { display: none; }\
#ejf-sd-toast { position: fixed; right: 18px; bottom: 18px; z-index: 9001; background: #333; color: #eee; padding: 8px 14px;\
  border-radius: 6px; box-shadow: 0 4px 18px rgba(0,0,0,.45); font-family: -apple-system,Arial,sans-serif; font-size: 12px; max-width: 320px; }',

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

    POS_KEY: 'sdPanelPos',         // GM flag holding the user's chosen panel position { left, top }
    COLLAPSE_KEY: 'sdPanelCollapsed',  // GM flag holding whether the panel is minimized (collapsed)

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
    },

    // Make the panel draggable by its header. Persists the final position to GM storage on drop so it is
    // restored on the next page load. The collapse "–" control is excluded so clicking it still toggles.
    _makeDraggable: function ($p) {
        var el = $p[0];
        var $head = $p.find('#ejf-sd-head');
        var dragging = false, startX = 0, startY = 0, baseLeft = 0, baseTop = 0;

        function onMove(e) {
            if (!dragging) { return; }
            var w = el.offsetWidth, h = el.offsetHeight;
            var left = Math.min(Math.max(0, baseLeft + (e.clientX - startX)), Math.max(0, window.innerWidth - w));
            var top = Math.min(Math.max(0, baseTop + (e.clientY - startY)), Math.max(0, window.innerHeight - h));
            el.style.left = left + 'px';
            el.style.top = top + 'px';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
            e.preventDefault();
        }
        function onUp() {
            if (!dragging) { return; }
            dragging = false;
            $p.removeClass('ejf-sd-dragging');
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('mouseup', onUp, true);
            var rect = el.getBoundingClientRect();
            try { if (typeof GM_setValue === 'function') { GM_setValue(EJF_SD.ui.POS_KEY, { left: Math.round(rect.left), top: Math.round(rect.top) }); } } catch (e) { /* ignore */ }
        }
        $head.on('mousedown', function (e) {
            if (e.which && e.which !== 1) { return; }                 // left button only
            if ($(e.target).closest('#ejf-sd-collapse').length) { return; }  // let the collapse toggle work
            var rect = el.getBoundingClientRect();
            baseLeft = rect.left; baseTop = rect.top;
            startX = e.clientX; startY = e.clientY;
            dragging = true;
            $p.addClass('ejf-sd-dragging');
            document.addEventListener('mousemove', onMove, true);
            document.addEventListener('mouseup', onUp, true);
            e.preventDefault();
        });
    },

    _ensurePanel: function () {
        EJF_SD.ui.injectCss();
        if ($('#ejf-sd-panel').length) { return; }
        var $p = $(
            '<div id="ejf-sd-panel">' +
            '  <div id="ejf-sd-head"><span id="ejf-sd-title">Similar defects</span>' +
            '    <span id="ejf-sd-mode">Keyword</span><span id="ejf-sd-collapse" title="Collapse / expand">–</span></div>' +
            '  <div id="ejf-sd-status"></div>' +
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
        });
        $p.appendTo(document.body);
        EJF_SD.ui._applyPos($p);          // restore the user's saved position (if any)
        EJF_SD.ui._makeDraggable($p);     // wire up header dragging
    },

    _item: function (r) {
        var pct = (typeof r.pct === 'number') ? r.pct : 0; // display % is computed per-mode in render()
        var meta = r.status || '';
        if (r.resolution) { meta += (meta ? ' · ' : '') + r.resolution; }
        var $li = $('<li></li>');
        $('<a></a>').attr('href', '/browse/' + r.key).attr('target', '_self').text(r.key).appendTo($li);
        $('<span class="ejf-sd-proj"></span>').text(r.project || '').appendTo($li);
        $('<span class="ejf-sd-score"></span>').text(pct + '%').appendTo($li);
        $('<div class="ejf-sd-sum"></div>').text(r.summary || '').appendTo($li);
        if (meta) { $('<div class="ejf-sd-meta"></div>').text(meta).appendTo($li); }
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

    render: function (key) {
        EJF_SD.ui._ensurePanel();
        $('#ejf-sd-list').empty();
        EJF_SD.ui.setStatus('Finding similar defects…');
        EJF_SD.ui.getIssueText(key).then(function (text) {
            return EJF_SD.db.countDefects().then(function (n) {
                if (!n) {
                    EJF_SD.ui.setStatus('No local data yet – open the Tampermonkey menu and click “Sync defects now”.');
                    return;
                }
                if (!text) { EJF_SD.ui.setStatus('Could not read this issue’s text.'); return; }
                return EJF_SD.rank.suggestBest(text, key).then(function (out) {
                    var results = out.results || [];
                    $('#ejf-sd-mode').text(out.mode);   // 'Hybrid' or 'Keyword'
                    if (!results.length) { EJF_SD.ui.setStatus('No similar defects found (' + n + ' indexed).'); return; }
                    EJF_SD.ui.setStatus(results.length + ' suggestions · ' + out.mode + ' · ' + n + ' indexed');
                    var $list = $('#ejf-sd-list');
                    for (var i = 0; i < results.length; i++) { $list.append(EJF_SD.ui._item(results[i])); }
                });
            });
        }).catch(function (e) { EJF_SD.ui.setStatus('Error: ' + (e && e.message || e)); });
    },

    // Show/refresh the panel only on EBR bug reports; re-query when the issue key changes.
    ensure: function () {
        if (!savedVariables[5][1]) { return; }
        var $bc = $('a[data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]');
        if (!$bc.length) { return; }
        var key = $.trim($bc.first().text());
        if (!/^EBR-/.test(key)) {
            // not a bug report - remove any stale panel
            if ($('#ejf-sd-panel').length) { $('#ejf-sd-panel').remove(); }
            EJF_SD.ui.currentKey = null;
            return;
        }
        if ($('#ejf-sd-panel').length && EJF_SD.ui.currentKey === key) { return; }
        EJF_SD.ui.currentKey = key;
        EJF_SD.ui.render(key);
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


/* ---- background auto-sync scheduler (Phase 3) ---- */
// Periodically runs a quiet incremental sync so the local DB stays fresh without the user clicking
// "Sync defects now". A best-effort cross-tab lease (GM storage) keeps multiple open Jira tabs from all
// syncing at once; the in-tab `running` flag prevents overlap within a tab. The big initial build stays
// manual - autoSync no-ops on an empty DB.
EJF_SD.sched = {
    INTERVAL_MS: 30 * 60 * 1000,   // run a catch-up roughly every 30 minutes
    STARTUP_DELAY_MS: 20 * 1000,   // wait a bit after load so we don't compete with first paint / initial render
    LEASE_TTL_MS: 5 * 60 * 1000,   // a lease older than this is treated as abandoned (tab closed mid-sync)
    LEASE_KEY: 'sdSyncLease',
    tabId: 'tab-' + Math.floor(Math.random() * 1e9) + '-' + Date.now(),
    _timer: null,

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
        if (!EJF_SD.sched._acquireLease()) { return; }    // another tab is the syncer right now
        EJF_SD.sync.autoSync();
    },

    start: function () {
        if (EJF_SD.sched._timer) { return; }
        setTimeout(function () {
            try { EJF_SD.sched.tick(); } catch (e) { /* swallow */ }
            EJF_SD.sched._timer = setInterval(function () {
                try { EJF_SD.sched.tick(); } catch (e) { /* swallow */ }
            }, EJF_SD.sched.INTERVAL_MS);
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
        setTimeout(function () { scheduled = false; try { EJF_SD.ui.ensure(); } catch (e) { /* swallow */ } }, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // also try once on load in case the breadcrumb is already present
    setTimeout(function () { try { EJF_SD.ui.ensure(); } catch (e) { /* swallow */ } }, 1500);
    // start the periodic background catch-up sync
    EJF_SD.sched.start();
})();
