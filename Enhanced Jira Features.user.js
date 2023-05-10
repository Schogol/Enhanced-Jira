// ==UserScript==
// @name        Enhanced Jira Features
// @version     1.1
// @description Adds a Translate, Assign to GM, Convert to Defect and Close button to Jira and also parses Log Files submitted from the EVE client
// @updateURL   https://raw.githubusercontent.com/Schogol/JiraButtons/master/Extra%20Jira%20buttons.user.js
// @downloadURL https://raw.githubusercontent.com/Schogol/JiraButtons/master/Extra%20Jira%20buttons.user.js
// @match       https://ccpgames.atlassian.net/*
// @require     https://gist.github.com/raw/2625891/waitForKeyElements.js
// @require     https://ajax.googleapis.com/ajax/libs/jquery/3.3.1/jquery.min.js
// @grant       GM_addStyle
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       GM_registerMenuCommand
// ==/UserScript==



// Variable which holds the Google Translate API key
var key = GM_getValue ("key", "");

// Variable which holds the value which either enables or disables the Log Parser. yes = enabled - no = disabled
var parser = GM_getValue ("parser", "");

// Variable which holds the value which either enables or disables the custom scrollbar. yes = enabled - no = disabled
var scrollbar = GM_getValue ("scrollbar", "");

// Variable which contains the logs later on in the script
var rows;


// Check if the Translation API key is set. If it isn't then prompt for the user to input the key
if (!key) {
    key  = prompt (
        'Translation API key not set. Please enter the key:',
        ''
    );
    GM_setValue ("key", key);
}

// Check if the parser variable is set. If it isn't then enable the log parser by setting the variable to yes
if (parser == "") {
    GM_setValue ("parser", "yes");
    parser = GM_getValue ("parser", "");
}

// Check if the scrollbar variable is set. If it isn't then enable the custom scrollbar by setting the variable to yes
if (scrollbar == "") {
    GM_setValue ("scrollbar", "yes");
    scrollbar = GM_getValue ("scrollbar", "");
}



// Add menu command that allows the Translation API key to be changed.
GM_registerMenuCommand ("Change Translation API Key", changeAPIKey);

function changeAPIKey () {
    promptAndChangeStoredValue (key, "Key", "key");
}

// Function which prompts the user to input a value for a Variable and saves it locally
function promptAndChangeStoredValue (targVar, userPrompt, setValVarName) {
    targVar     = prompt (
        'Change ' + userPrompt + ' for ' + location.hostname + ':',
        targVar
    );
    GM_setValue (setValVarName, targVar);
    key  = GM_getValue ("key", "");
};

// Add menu command that will allow to toggle On/Off the Log Parser.
GM_registerMenuCommand ("Toggle LogParser On / Off", toggleParser);

function toggleParser () {
    switch (parser) {
        case "yes":
            GM_setValue ("parser", "no");
            parser = GM_getValue ("parser", "");
            break;
        default:
            GM_setValue ("parser", "yes");
            parser = GM_getValue ("parser", "");
            break;
    }
};

// Add menu command that will allow to toggle On/Off the custom scrollbar.
GM_registerMenuCommand ("Toggle custom scrollbar On / Off", toggleScrollbar);

function toggleScrollbar () {
    switch (scrollbar) {
        case "yes":
            GM_setValue ("scrollbar", "no");
            scrollbar = GM_getValue ("scrollbar", "");
            break;
        default:
            GM_setValue ("scrollbar", "yes");
            scrollbar = GM_getValue ("scrollbar", "");
            break;
    }
};



// waitForKeyElements waits until the it finds the "Give Feedback" element of the page and then removes it because we dont want that to take up space.
var feedbackItem = 'button[data-testid="issue-navigator.common.ui.feedback.feedback-button"]';
waitForKeyElements (feedbackItem, removeFeedbackButton);

function removeFeedbackButton() {
    $('button[data-testid="issue-navigator.common.ui.feedback.feedback-button"]').parent().remove()
};


// waitForKeyElements waits until the page is loaded and then runs the checkIssueType function.
var issueItem = 'a[data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]';
waitForKeyElements (issueItem, checkIssueType);


// Check if the issue is a Bug report. If it is then we add the extra buttons
function checkIssueType() {
    if ($('a[data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]:contains("EBR")').length > 0) {
        addButtons();
    }
};

// Adds the different buttons to the "command-bar" and defines what they do
function addButtons() {
    // Variable which contains the current Issue ID which we need
    var issueID = $('a[data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]').text();

    // Grabbing the button and span class for the buttons (which constantly changes because react + atlassian ~_~)
    let buttonClass = jQuery('span[data-testid="issue.issue-view.views.issue-base.foundation.quick-add.quick-add-item.add-attachment"]').children(1).attr('class');
    let spanClass = jQuery('span[data-testid="issue.issue-view.views.issue-base.foundation.quick-add.quick-add-item.add-attachment"]').attr('class');

    // Jira cloud ID which we need for some of the POST requests we send
    let ajscloudid = $('meta[name="ajs-cloud-id"]').attr('content');


    var translatebutton= $('<span id="translateButton" class="' + spanClass + '" style="margin-left: 8px;"><button aria-label="Translate" class="' + buttonClass + '" type="button" tabindex="1"><span>Translate</span></button></span>');
    $('span[data-testid="issue.issue-view.views.issue-base.foundation.quick-add.quick-add-item.add-attachment"]').parent().parent().append(translatebutton);

    // When the translate button is clicked we send the Issue title, description and reproduction steps to the Google translate API and change the original content to what we receive back from the API
    $("#translateButton").click(function () {
	$.ajax({
       	url: 'https://translation.googleapis.com/language/translate/v2?key=' + key,
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


    var GMButton= $('<span id="GMButton" class="' + spanClass + '"><button aria-label="Translate" class="' + buttonClass + '" type="button" tabindex="1"><span>Assign to GM</span></button></span>');
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



    var convertToDefectButton= $('<span id="ConvertToDefectButton" class="' + spanClass + '"><button aria-label="Translate" class="' + buttonClass + '" type="button" tabindex="1"><span>Convert to Defect</span></button></span>');
    $('span[data-testid="issue.issue-view.views.issue-base.foundation.quick-add.quick-add-item.add-attachment"]').parent().parent().append(convertToDefectButton);

    // When the Convert to Defect button is clicked we trigger the Automation which converts the EBR into an EDR issue
    $("#ConvertToDefectButton").click(function () {

        $.ajax({
       	url: 'https://ccpgames.atlassian.net/gateway/api/automation/internal-api/jira/' + ajscloudid + '/pro/rest/rules/invocation/10609113',
   			type: 'POST',
   			contentType: 'application/json',
			charset: 'utf-8',
    		data: '{"targetIssueKeys":["' + issueID + '"]}',

			// After 5 seconds (which should be enough for Jira to execute and complete the Automation we reload the page so that the user can see that the EDR issue was created.
            success: function (data) {
        		setTimeout(function(){window.location.reload(false)}, 5000);
			},

    		// If we get an Error then we annoy the user by telling them that it failed and to check their Dev Console for errors
    		error: function(data){
           		console.log(JSON.stringify(data));
    			alert("This failed for some reason. Check Console for errors and report issues to Schogol :).");
    		}
    	})
	});


    var closeButton= $('<span id="closeButton" class="' + spanClass + '"><button aria-label="Translate" class="' + buttonClass + '" type="button" tabindex="1"><span>Close</span></button></span>');
    $('span[data-testid="issue.issue-view.views.issue-base.foundation.quick-add.quick-add-item.add-attachment"]').parent().parent().append(closeButton);

    // When the Close button is clicked we change the status to Closed by simulating clicks on the relevant buttons. This is extremely janky right now because I cant figure out a better way to do this.
    $("#closeButton").click(function () {
        $("div[data-testid='issue.views.issue-base.foundation.status.status-field-wrapper']").find("button").click()
        setTimeout(function(){$("div[data-testid='issue.fields.status.common.ui.status-lozenge.3']").children().find("span:contains(Closed)").click();}, 100);
	});
};



// Switch to a custom scrollbar if the scrollbar value is set to yes
switch (scrollbar) {
    case "yes":
        GM_addStyle('*::-webkit-scrollbar { width: 11px !important; height: 11px !important; background-color: #F5F5F5 !important; }');
        GM_addStyle('*::-webkit-scrollbar-thumb { border-radius: 10px !important; background: linear-gradient(left, #96A6BF, #63738C) !important;box-shadow: inset 0 0 1px 1px #cad1d9 !important;}');
        GM_addStyle('.notion-scroller.horizontal { margin-bottom: 30px !important; }');
        GM_addStyle('.notion-scroller.vertical { margin-bottom: 0px !important; }');
        break;
    case "no":
        break;
};



// When we detect the "title row" of a log parser file then we swap out the content of the log file with a parsed, more readable version of it with some extra features likke buttons which allow you to toggle the visibility of certain types of events
var selector = "span[data-testid='code-block']:contains(Time	Facility	Type	Message)";
waitForKeyElements (selector, ArtificialSlowdown);

// If the parser value is set we Swap out the Log file with the parsed version after 500ms (This slowdown seems to help with weird issues where atlassian seems to time how long content takes to load files but if we have swapped out the file before atlassian realizes that it completed loading then errors might occur)
function ArtificialSlowdown() {
    switch (parser) {
        case "yes":
            setTimeout(SwapUI, 500);
            break;
        case "no":
            break;
    };
};


function SwapUI() {
    $('span[data-testid="code-block"]').find('span > span.comment').remove()
    rows = $("span[data-testid='code-block']").text();
    $("span[data-testid='code-block']").html(html);
    setTimeout(ParseLogs, 250);

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
                    $('tr:not(.exception)').css({'display':'none'});
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


function ParseLogs() {
    rows = rows.replace(/(\t{2,})+/g, "\t").replace(/([\r\n]){2,}/g, "\r\n").replace(/([\r\n])[*]{3}(.*)(?=[*]{3})[*]{3}/g, "\r\n\t\t\tLogging error occurred").replace(/[\<]/g, function(c) {return "&lt;";}).split("\n");

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
        var tableContentRowsLength = tableContent.rows.length;
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
    logs.showRow((rows.length - 2));


/**
 * Remove the loader and show the content
 */
    document.getElementById("loader").style.display = "none";
    document.getElementById("tableContent").style.display = "table";
};






var html = `
<style>
    body {
      color: #333;
      font: 13px/1.2 Arial,Helvetica,sans-serif;
    }
    td:first-child, th:first-child {
       padding: 4px 8px;
    }
    th {
      vertical-align: top;
      text-align: left;
      font-weight: bold;
    }
    #header-fixed {
      border-bottom: 0px;
      text-align: center;
    }
    #header-fixed tr th {
      vertical-align: top;
      font-weight: bold;
      width: 68px;
    }
    #header-fixed tr th+th {
      vertical-align: top;
      font-weight: bold;
      width: 257px;
    }
    #header-fixed tr th+th+th {
      vertical-align: top;
      font-weight: bold;
      width: 69px;
    }
    #header-fixed tr th+th+th+th {
      vertical-align: top;
      font-weight: bold;
      width: auto;
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
      cursor: default;
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
    html {
      height: 100%;
      background-color: #FFF;
      background: -webkit-gradient(linear,left top,left bottom,from(#EEE),to(#FFF));
      background: -webkit-radial-gradient(#FFF,#FFF 35%,#EEE);
      background: -moz-radial-gradient(#FFF,#FFF 35%,#EEE);
      background: radial-gradient(#FFF,#FFF 35%,#EEE);
      -webkit-user-select: none;
      -khtml-user-select: none;
      -moz-user-select: -moz-none;
      -o-user-select: none;
      user-select: text;
      -webkit-touch-callout: none;
      -webkit-tap-highlight-color: transparent;
      -webkit-text-size-adjust: none;
      -webkit-font-smoothing: antialiased;
      cursor: default;
    }
    body {
      margin: 0;
      background-color: transparent;
      overflow: hidden;
    }
    a {
      outline: none;
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
    #gnav {
      float: left;
      overflow: hidden;
    }
    #body {
      margin-top: -20px;
      overflow: auto;
    }
    #body h1 {
      margin: 0;
      padding: 10px 20px 5px;
      border-bottom: 1px solid #CCC;
      color: #848589;
      font: 400 30px 'Segoe UI',Arial,Helvetica,sans-serif;
      height: 41px;
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
    #table {
      position: absolute;
      top: 85px;
      bottom: 0;
      width: 100%;
      -webkit-transition: .3s linear;
      -moz-transition: .3s linear;
      transition: .3s linear;
      overflow-y: scroll;
      margin-top: 20px;
    }
    #table.hidden {
      opacity: 0;
      -webkit-transform: scale(0);
      -moz-transform: scale(0);
      -o-transform: scale(0);
      -ms-transform: scale(0);
      transform: scale(0);
    }
    #table:focus {
      outline: none;
    }
    ::-moz-focus-inner {
      border: none;
    }
    #table table {
      width: 100%;
      border-collapse: collapse;
      border-spacing: 0;
      table-layout: fixed;
      -webkit-box-sizing: content-box;
      -moz-box-sizing: content-box;
      box-sizing: content-box;
    }
    #tableHeader {
      top: 101px;
    }
    #tableContent {
      word-wrap: break-word;
      table-layout: fixed;
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
    #header-fixed {
      position: fixed;
      top: 85px;
      display:table;
      width: -webkit-fill-available;
    }


/* Center the loader */
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

/* Add animation to "page content" */
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

#myDiv {
  display: none;
  text-align: center;
}
</style>

<title>Log Parser | Jira</title>
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
         <table id="tableHeader">
            <colgroup>
               <col class="timeCol">
               <col class="facilityCol">
               <col class="typeCol">
               <col class="messageCol">
            </colgroup>
            <thead id ="header-fixed">
               <tr id = "fixedHead">
                  <th>Time
                  <th>Facility
                  <th>Type
                  <th>Message
            </thead>
         </table>
         <table id="tableContent" style="display:none;">
            <div id="loader"></div>
            <colgroup>
               <col class="timeCol">
               <col class="facilityCol">
               <col class="typeCol">
               <col class="messageCol">
            </colgroup>
            <tbody></tbody>
         </table>
      </div>
   </div>
`;
