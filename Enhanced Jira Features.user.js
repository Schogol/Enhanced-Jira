// ==UserScript==
// @name        Enhanced Jira Features
// @version     2.3
// @author      ISD BH Schogol
// @description Adds a Translate, Assign to GM, Convert to Defect and Close button to Jira and also parses Log Files submitted from the EVE client
// @updateURL   https://github.com/Schogol/Enhanced-Jira/raw/main/Enhanced%20Jira%20Features.user.js
// @downloadURL https://github.com/Schogol/Enhanced-Jira/raw/main/Enhanced%20Jira%20Features.user.js
// @match       https://ccpgames.atlassian.net/jira*
// @match       https://ccpgames.atlassian.net/browse*
// @match       https://ccpgames.atlassian.net/issues*
// @require     https://gist.github.com/raw/2625891/waitForKeyElements.js
// @require     https://ajax.googleapis.com/ajax/libs/jquery/3.3.1/jquery.min.js
// @grant       GM_addStyle
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       GM_registerMenuCommand
// ==/UserScript==



// Creating various variables which we use later on
var rows, oc, lc, pdm, pdmdata, driverAge = "unknown", menu_parser, menu_scrollbar, menu_dropdowns, menu_buttons, menu_darkmode;


// Current Date
var today = new Date();


// Array which contains the locally saved values for a couple of variables
var savedVariables = [["key",""], ["parser", ""], ["scrollbar", ""], ["dropdowns", ""], ["buttons", ""]];


// Listener which triggers when the locally scaved scrollbar value is changed. If the new value is "no" we remove the custom scrollbar. If the new value is "yes" we add the custom scrollbar.
GM_addValueChangeListener("scrollbar", function(key, oldValue, newValue, remote) {
    if (newValue == "no") {
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


// Listener which triggers when the locally scaved buttons value is changed. If the new value is "no" we remove the custom buttons. If the new value is "yes" we add the custom buttons.
GM_addValueChangeListener("buttons", function(key, oldValue, newValue, remote) {
    if (newValue == "no") {
        $('#translateButton').remove();
        $('#GMButton').remove();
        $('#ConvertToDefectButton').remove();
        $('#closeButton').remove();
    } else {
        addButtons();
    }
});


// Listener which triggers when the locally scaved dropdowns value is changed. If the new value is "no" we remove functionality of the LinkedIssue dropdowns. If the new value is "yes" we add the dropdowns to LinkedIssues.
GM_addValueChangeListener("dropdowns", function(key, oldValue, newValue, remote) {
    if (newValue == "no") {
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


// Iterate through all variables in savedVariables and load their locally saved values or set them to "yes" if they are not set yet
for (let i = 0; i < savedVariables.length; i++) {
    savedVariables[i][1] = GM_getValue (savedVariables[i][0], "");
    if (savedVariables[i][1] == "") {
        GM_setValue (savedVariables[i][0], "yes");
        savedVariables[i][1] = GM_getValue (savedVariables[i][0], "");
    }
}


// Check if the Translation API key is set. If it isn't then prompt for the user to input the key.
if (!savedVariables[0][1] || savedVariables[0][1] == "yes") {
    savedVariables[0][1] = prompt (
        'Translation API key not set. Please enter the key:',
        ''
    );
    GM_setValue (savedVariables[0][0], savedVariables[0][1]);
}


// Activate a custom scrollbar if the scrollbar value is set to yes
if (savedVariables[2][1] == "yes") {
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
if (savedVariables[1][1] == "yes") {
    menu_parser = GM_registerMenuCommand ("Disable Log Parser", toggleParser);
}
else {
    menu_parser = GM_registerMenuCommand ("Enable Log Parser", toggleParser);
}



// Add menu command that will allow to toggle On/Off the custom scrollbar.
if (savedVariables[2][1] == "yes") {
    menu_scrollbar = GM_registerMenuCommand ("Disable Custom Scrollbar", toggleScrollbar);
}
else {
    menu_scrollbar = GM_registerMenuCommand ("Enable Custom Scrollbar", toggleScrollbar);
}



// Add menu command that will allow to toggle On/Off the dropdown lists on Linked Issues.
if (savedVariables[3][1] == "yes") {
    menu_dropdowns = GM_registerMenuCommand ("Disable Linked Issue Dropdowns", toggleDropdown);
}
else {
    menu_dropdowns = GM_registerMenuCommand ("Enable Linked Issue Dropdowns", toggleDropdown);
}



// Add menu command that will allow to toggle On/Off the extra buttons on bug reports.
if (savedVariables[4][1] == "yes") {
    menu_buttons = GM_registerMenuCommand ("Disable Extra Buttons", toggleButtons);
}
else {
    menu_buttons = GM_registerMenuCommand ("Enable Extra Buttons", toggleButtons);
}



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


// Function which toggles between "yes" and "no" for the parser variable and saves it locally
function refreshMenu() {
    GM_unregisterMenuCommand(menu_parser);
    GM_unregisterMenuCommand(menu_scrollbar);
    GM_unregisterMenuCommand(menu_dropdowns);
    GM_unregisterMenuCommand(menu_buttons);
    GM_unregisterMenuCommand(menu_darkmode);

    if (savedVariables[1][1] == "yes") {
        menu_parser = GM_registerMenuCommand ("Disable Log Parser", toggleParser);
    }
    else {
        menu_parser = GM_registerMenuCommand ("Enable Log Parser", toggleParser);
    }

    if (savedVariables[2][1] == "yes") {
        menu_scrollbar = GM_registerMenuCommand ("Disable Custom Scrollbar", toggleScrollbar);
    }
    else {
        menu_scrollbar = GM_registerMenuCommand ("Enable Custom Scrollbar", toggleScrollbar);
    }

    if (savedVariables[3][1] == "yes") {
        menu_dropdowns = GM_registerMenuCommand ("Disable Linked Issue Dropdowns", toggleDropdown);
    }
    else {
        menu_dropdowns = GM_registerMenuCommand ("Enable Linked Issue Dropdowns", toggleDropdown);
    }

    if (savedVariables[4][1] == "yes") {
        menu_buttons = GM_registerMenuCommand ("Disable Extra Buttons", toggleButtons);
    }
    else {
        menu_buttons = GM_registerMenuCommand ("Enable Extra Buttons", toggleButtons);
    }

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
    savedVariables[i][1] = (savedVariables[i][1] == "yes") ? "no" : "yes";
    GM_setValue (savedVariables[i][0], savedVariables[i][1]);
};
*/


// Function which toggles between "yes" and "no" for the parser variable and saves it locally
function toggleParser() {
    savedVariables[1][1] = (savedVariables[1][1] == "yes") ? "no" : "yes";
    GM_setValue (savedVariables[1][0], savedVariables[1][1]);
    refreshMenu();
};


// Function which toggles between "yes" and "no" for the scrollbar variable and saves it locally
function toggleScrollbar() {
    savedVariables[2][1] = (savedVariables[2][1] == "yes") ? "no" : "yes";
    GM_setValue (savedVariables[2][0], savedVariables[2][1]);
    refreshMenu();
};


// Function which toggles between "yes" and "no" for the dropdowns variable and saves it locally
function toggleDropdown() {
    savedVariables[3][1] = (savedVariables[3][1] == "yes") ? "no" : "yes";
    GM_setValue (savedVariables[3][0], savedVariables[3][1]);
    refreshMenu();
};


// Function which toggles between "yes" and "no" for the buttons variable and saves it locally
function toggleButtons() {
    savedVariables[4][1] = (savedVariables[4][1] == "yes") ? "no" : "yes";
    GM_setValue (savedVariables[4][0], savedVariables[4][1]);
    refreshMenu();
};


// Function which toggles darkmode on / off by sending the nescessary PUT command to the atlassian server to change the dark mode setting. It then reloads the page
function toggleDarkmode() {
    if ($('html[data-color-mode="dark"]')[0]) {
        $('input[type=checkbox]').prop('checked', false);
        $.ajax({
            url: 'https://ccpgames.atlassian.net/rest/api/3/mypreferences?key=jira.user.theme.preference',
            type: 'PUT',
            contentType: 'application/json',
            charset: 'utf-8',
            Accept: 'application/json,text/javascript,*/*',
            data: '{"value":"light"}',
        })
    } else {
        $('input[type=checkbox]').prop('checked', true);
        $.ajax({
            url: 'https://ccpgames.atlassian.net/rest/api/3/mypreferences?key=jira.user.theme.preference',
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
    if ($('a[data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]:contains("EBR")').length > 0 & savedVariables[4][1] == "yes") {
        addButtons();
    }
};


// Adds the different buttons to the "command-bar" and defines what they do
function addButtons() {
    // Variable which contains the current Issue ID which we need
    var issueID = $('a[data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]').text();

    // Grabbing the button and span class for the buttons (which constantly changes because react + atlassian ~_~)
    let buttonClass = $('span[data-testid="issue.issue-view.views.issue-base.foundation.quick-add.quick-add-item.add-attachment"]').children(1).attr('class');
    let spanClass = $('span[data-testid="issue.issue-view.views.issue-base.foundation.quick-add.quick-add-item.add-attachment"]').attr('class');

    // Jira cloud ID which we need for some of the POST requests we send
    let ajscloudid = $('meta[name="ajs-cloud-id"]').attr('content');


    var translatebutton= $('<span id="translateButton" class="' + spanClass + '" style="margin-left: 8px;"><button aria-label="Translate" class="' + buttonClass + '" type="button" tabindex="1"><span>Translate</span></button></span>');
    $('span[data-testid="issue.issue-view.views.issue-base.foundation.quick-add.quick-add-item.add-attachment"]').parent().parent().append(translatebutton);

    // When the translate button is clicked we send the Issue title, description and reproduction steps to the Google translate API and change the original content to what we receive back from the API
    $("#translateButton").click(function () {
        $.ajax({
            url: 'https://translation.googleapis.com/language/translate/v2?key=' + savedVariables[0][1],
            type: 'POST',
            contentType: 'application/json',
            charset: 'utf-8',

            // The regex might be a bit janky but it removes some unneccessary spaces in the text which we send to the API.
            // By changing the "target:" attribute we could chose a different language than english if needed
            data: '{"q":"'+ $("h1[data-test-id='issue.views.issue-base.foundation.summary.heading']").text().replace(/"/g,'').replace(/ {2,}/g,' ')+'", "q":"'+ $("div[data-component-selector='jira-issue-view-rich-text-inline-edit-view-container']").children().eq(0).text().replace(/"/g,'').replace(/ {2,}/g,' ')+'", "q":"'+ $("div[data-component-selector='jira-issue-view-rich-text-inline-edit-view-container']").children().eq(1).text().replace(/"/g,'').replace(/ {2,}/g,' ')+'", "target":"en", "format":"text"}',

            // When we receive a translation back from the API we replace the original Title, Description and Repro-Steps with the translation we get from Google.
            success: function (data) {
                $("h1[data-test-id='issue.views.issue-base.foundation.summary.heading']").text(data.data.translations[0].translatedText);
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


    var GMButton= $('<span id="GMButton" class="' + spanClass + '"><button class="' + buttonClass + '" type="button" tabindex="1"><span>Assign to GM</span></button></span>');
    $('span[data-testid="issue.issue-view.views.issue-base.foundation.quick-add.quick-add-item.add-attachment"]').parent().parent().append(GMButton);

    // When the Assign to GM button is clicked we change the Team to "EO - Game Masters" and also visually change the field so the user sees that it worked.
    $("#GMButton").click(function () {
        $.ajax({
            url: 'https://ccpgames.atlassian.net/rest/api/2/issue/'+ $('a[data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]').text(),
            type: 'PUT',
            contentType: 'application/json',
            charset: 'utf-8',
            data: '{"fields":{"customfield_10001":"38"}}',

            // When the change of the team via API is successful we change the Team visually for the user to also see that as the Issue doesnt update automatically
            success: function (data) {
                $('div[data-testid="issue-field-heading-styled-field-heading.field"]:contains(Team)').parent().children('div').eq(1).text('EO - GameMasters');
                // After changing the Team field to "EO - Game Masters" we change the Assignee field to "Unassigned" because GMs wont be able to see the BRs in their filters if they are assigned to someone.
                $.ajax({
                    url: 'https://ccpgames.atlassian.net/rest/api/3/issue/'+ $('a[data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]').text() + '/assignee',
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



    var convertToDefectButton= $('<span id="ConvertToDefectButton" class="' + spanClass + '"><button class="' + buttonClass + '" type="button" tabindex="1"><span>Convert to Defect</span></button></span>');
    $('span[data-testid="issue.issue-view.views.issue-base.foundation.quick-add.quick-add-item.add-attachment"]').parent().parent().append(convertToDefectButton);

    // When the Convert to Defect button is clicked we trigger the Automation which converts the EBR into an EDR issue
    $("#ConvertToDefectButton").click(function () {
        $.ajax({
            url: 'https://ccpgames.atlassian.net/gateway/api/automation/internal-api/jira/' + ajscloudid + '/pro/rest/rules/invocation/10609113',
            type: 'POST',
            contentType: 'application/json',
            charset: 'utf-8',
            data: '{"targetIssueKeys":["' + issueID + '"]}',

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
    });


    var closeButton= $('<span id="closeButton" class="' + spanClass + '"><button class="' + buttonClass + '" type="button" tabindex="1"><span>Close</span></button></span>');
    $('span[data-testid="issue.issue-view.views.issue-base.foundation.quick-add.quick-add-item.add-attachment"]').parent().parent().append(closeButton);

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

    if (savedVariables[3][1] == "yes") {
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
var phSelector = "span[data-testid='code-block']:contains(dateTime	pyDateTime	procCpu	threadCpu	pyMem	virtualMem	runnable1	runnable2	watchdog time	spf	serviceCalls	callsFromClient	bytesReceived	bytesSent	packetsReceived	packetsSent	sessionCount	tidiFactor)";
waitForKeyElements(phSelector, SwapUI);


// When we detect the "title row" of a methodCalls file then we swap out the content of the log file with a parsed, more readable version of it with some extra features
var McSelector = "span[data-testid='code-block']:contains(Time	Method	Duration [ms])";
waitForKeyElements(McSelector, SwapUI);


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


// Swap out the UI when looking at a log file and add the buttons to toggle message types at the top of the page
function SwapUI() {
    $('code > span:empty').remove()
    $('span[data-testid="code-block"]').find('span > span.comment').remove()
    rows = $("span[data-testid='code-block']").text();

    if ($("span[data-testid='code-block']:contains(Time	Facility	Type	Message)")[0] && savedVariables[1][1] == "yes") {
        $("span[data-testid='code-block']").html(html);
        setTimeout(ParseLogs, 250);
    }

    else if ($("span[data-testid='code-block']:contains(dateTime	pyDateTime	procCpu	threadCpu	pyMem	virtualMem	runnable1	runnable2	watchdog time	spf	serviceCalls	callsFromClient	bytesReceived	bytesSent	packetsReceived	packetsSent	sessionCount	tidiFactor)")[0] && savedVariables[1][1] == "yes") {
        $("span[data-testid='code-block']").html(phHtml);
        setTimeout(ParsePhLogs, 250);
    }

    else if ($("span[data-testid='code-block']:contains(Time	Method	Duration [ms])")[0] && savedVariables[1][1] == "yes") {
        $("span[data-testid='code-block']").html(McHtml);
        setTimeout(ParseMcLogs, 250);
    }

    else if (oc && savedVariables[1][1] == "yes") {
        $("span[data-testid='code-block']").html(ocHtml);
        oc = false;
        setTimeout(ParseOcLogs, 250);
    }

    else if (lc && savedVariables[1][1] == "yes") {
        $("span[data-testid='code-block']").html(lcHtml);
        lc = false;
        setTimeout(ParseOcLogs, 250);
    }

    else if (pdm && savedVariables[1][1] == "yes") {
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
        for (var i = tableContentRowsLength, row, rowNumber, cellIndex, dateTime, pyDateTime, procCpu, threadCpu, pyMem, virtualMem, runnable1, runnable2, watchdogTime, spf, serviceCalls, callsFromClient, bytesReceived, bytesSent, packetsReceived, packetsSent, sessionCount, tidiFactor; i < toIndex; ++i) {
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
            runnable1 = row.insertCell(++cellIndex);
            runnable1.innerHTML = table[i][6];
            runnable2 = row.insertCell(++cellIndex);
            runnable2.innerHTML = table[i][7];
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
    }

    #averageMacho {
      text-align: right;
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
      background: #f99;
    }

    .yellow {
      background: #ff9;
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
    }

    #table table {
      width: max-content;
      border-collapse: collapse;
      border-spacing: 0;
      table-layout: fixed;
      -webkit-box-sizing: content-box;
      -moz-box-sizing: content-box;
      box-sizing: content-box;
      word-wrap: break-word;
      table-layout: fixed;
      color: #333;
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
      background: #99ff99;
    }

    .warning {
      background: #ff9;
    }

    .error {
      background: #f99;
    }

    .info {
      background: #7dcbff;
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
                  <th scope="col">runnable1 <i class="fa-regular fa-circle-question" title="How many python threads are waiting to be run"></i>
                  <th scope="col">runnable2 <i class="fa-regular fa-circle-question" title="How many python threads are waiting to be run"></i>
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
waitForKeyElements (searchbar, addDarkmodeToggle);


// This adds the CSS and Button (An input checkbox box) to the left of the search box. If the darkmode is enabled then we check the checkbox
function addDarkmodeToggle() {
    GM_addStyle(darkModeSwitchCss);
    if ($('html[data-color-mode="dark"]')[0] || $('html[data-color-mode="light"]')[0]) {
        $('input[data-test-id="search-dialog-input"').parent().parent().parent().parent().parent().parent().parent().parent().parent().prepend(darkModeSwitch);
        if ($('html[data-color-mode="dark"]')[0]) {
            $('input[type=checkbox]').prop('checked', true);
        };
        $('input[type=checkbox]').on( "click", toggleDarkmode);
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
