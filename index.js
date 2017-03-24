#! /usr/bin/env node
const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const Promise = require('bluebird');
const jira = require('jira-connector');
const preferences = require('preferences');
const inquirer = require('inquirer');
const exec = require('child_process').exec;

var prefs = new preferences('jira-git-helper', {
  jiraHost: null,
  email: null,
  agileBoardId: null,
  useSprints: true,
  labelForUpcomingWork: null,
  addChangelogEntry: true,
  changelogFilenames: {}
});

// The first time the utility is run, ask for the JIRA hostname.
promise = Promise.try(() => {
  if (prefs.jiraHost) { return; }

  return inquirer.prompt({ name: 'host', message: 'What is your JIRA hostname? (e.g. company.atlassian.net)' }).then((answer) => {
    prefs.jiraHost = answer.host;
  });
});

var jiraClient;

// Get the user's credentials.
var credentialPrompt = [
  {
    name: 'email',
    message: 'What is the email address you use to log into JIRA?'
  },
  {
    name: 'password',
    type: 'password',
    message: 'What is your JIRA password?'
  }
];

if (prefs.email) {
  credentialPrompt[0].default = prefs.email;
}

promise = promise.then(() => {
  return inquirer.prompt(credentialPrompt);
});
promise = promise.then((answers) => {
  prefs.email = answers.email;

  var base64Credentials = new Buffer(answers.email + ':' + answers.password).toString('base64');
  jiraClient = new jira({
    host: prefs.jiraHost,
    basic_auth: {
      base64: base64Credentials
    }
  });
});

// Choose a JIRA agile board.
promise = promise.then(() => {
  return Promise.fromCallback((callback) => {
    jiraClient.board.getAllBoards({}, (err, result) => {
      if (err) { return callback(err); }

      var boards = _.keyBy(result.values, 'name');
      var boardChoices = {
        name: 'boardName',
        type: 'list',
        message: 'Choose an Agile board:',
        choices: Object.keys(boards)
      };

      // If a board has been selected in the past, find it by its id, and set it as the default choice.
      if (prefs.agileBoardId) {
        for (var i=0; i < boardChoices.choices.length; i++) {
          if (boards[boardChoices.choices[i]].id === prefs.agileBoardId) {
            boardChoices.default = i;
            break;
          }
        }
      }

      inquirer.prompt(boardChoices).then((answers) => {
        callback(null, boards[answers.boardName]);
      });
    });
  });
});

// Get the active sprint.
promise = promise.then((board) => {
  prefs.agileBoardId = board.id;
  // If the user previously indicated sprints are not being used, move on.
  if (prefs.useSprints === false) {
    return null, { boardName: board.name } ;
  }
  return Promise.fromCallback((callback) => {
    jiraClient.board.getSprintsForBoard({ boardId: board.id, state: 'active' }, (err, result) => {
      if (err) {
        // If the board doesn't support sprints, continue.
        if (err.errorMessages && err.errorMessages.length > 0 && err.errorMessages[0] === 'The board does not support sprints') {
          return callback(null, { boardName: board.name });
        }
        return callback(err);
      }

      // Continue if there are no active springs.
      if (!result.values || result.values.length === 0) {
        return callback(null, { boardName: board.name });
      }

      // Assume there's only a single active sprint per board.
      // TODO: is this always a valid assumption?
      callback(null, { activeSprint: result.values[0] });
    });
  });
});

// Figure out what (if anything) we can add to our query to narrow the issue list.
promise = promise.then((selectorInfo) => {
  // If we're using sprints and there's an active one, use it.
  if (selectorInfo.activeSprint) {
    return 'AND Sprint = "' + selectorInfo.activeSprint.name + '"';
  }

  var extraQuerySelector = 'AND project = ' + selectorInfo.boardName;
  // If the user previously indicated a label is used to indicate upcoming work, use it.
  if (prefs.labelForUpcomingWork) {
    return extraQuerySelector + ' AND labels = "' + prefs.labelForUpcomingWork + '"';
  }

  // If there is no label, but user was already asked about it, don't ask again.
  if (prefs.useSprints === false) {
    return extraQuerySelector;
  }

  prefs.useSprints = false;

  return inquirer.prompt({ type: 'confirm', name: 'useLabel', message: 'Instead of sprints, do you use a label to indicate upcoming work?', default: true }).then((answer) => {
    if (!answer.useLabel) {
      console.log('> Got it, will show all issues.');
      return extraQuerySelector;
    }

    return inquirer.prompt({ type: 'input', name: 'nextLabel', message: 'Please enter that label:' }).then((answer) => {
      if (answer.nextLabel.trim().length == 0) {
        console.log('> Ok, no label then.');
        return extraQuerySelector;
      }
      prefs.labelForUpcomingWork = answer.nextLabel;
      return extraQuerySelector + ' AND labels = "' + prefs.labelForUpcomingWork + '"';
    });
  });
});

// Get issues and format list of choices.
promise = promise.then((extraQuerySelector) => {
  return Promise.fromCallback((callback) => {
    jiraClient.search.search({
      jql: 'assignee = "' + prefs.email + '" AND status in (New, "In Progress") ' + extraQuerySelector,
      fields: [ 'key', 'project', 'created', 'priority', 'reporter', 'sprint', 'status', 'summary' ]
    }, (err, searchResults) => {
      if (err) { return callback(err); }

      // Error if there are no new issues.
      if (searchResults.total === 0) {
        return callback("No New or In Progress issues assigned to you were found in the current sprint!");
      }

      var issuesByStatus = _.groupBy(searchResults.issues, 'fields.status.name');
      var statusTypes = Object.keys(issuesByStatus).sort();
      var issueChoices = issuesByStatus[statusTypes[0]];

      if (statusTypes.length > 1) {
        for (var i = 1; i < statusTypes.length; i++) {
          // Add a separator between each issue type.
          issueChoices.push(new inquirer.Separator());
          issueChoices = issueChoices.concat(issuesByStatus[statusTypes[i]]);
        }
      }

      var issue;
      for (var i = 0; i < issueChoices.length; i++) {
        issue = issueChoices[i];
        if (!(issue instanceof inquirer.Separator)) {
          issueChoices[i] = {
            name: issue.key + '\t' + issue.fields.priority.name + '\t' + issue.fields.summary,
            short: issue.key,
            value: {
              id: issue.id,
              key: issue.key,
              summary: issue.fields.summary,
              status: issue.fields.status.name
            }
          }
        }
      }
      callback(null, issueChoices);
    });
  });
});

// Choose ticket.
promise = promise.then((issueChoices) => {
  return inquirer.prompt({ type: 'list', name: 'issue', message: 'Which ticket are you starting to work on?', choices: issueChoices });
});

// Offer to transition New ticket to In Progress.
promise = promise.then((selectedTicket) => {
  if (selectedTicket.issue.status !== 'New') { return selectedTicket.issue; }
  return inquirer.prompt({ type: 'confirm', name: 'moveTicket', message: 'Transition ticket status to In Progress?', default: true }).then((answer) => {
    if (!answer.moveTicket) { return selectedTicket.issue; }

    return Promise.fromCallback((callback) => {
      jiraClient.issue.transitionIssue({ issueId: selectedTicket.issue.id, transition: { id: 11 } }, (err, result) => {
        if (err) { return callback(err); }

        console.log('\t...done!');
        callback(null, selectedTicket.issue);
      })
    });
  });
});

// Choose branch name, ask to move to master branch, pull latest.
promise = promise.then((selectedTicket) => {
  return inquirer.prompt({ type: 'input', name: 'branchName', message: 'What would you like to name the branch?', default: selectedTicket.key.toLowerCase() + '-' + _.kebabCase(selectedTicket.summary) }).then((branchNameAnswer) => {
    gitPromise = Promise.fromCallback((callback) => {
      exec('git status', (err, stdout, stderr) => {
        if (stdout.startsWith('On branch master')) { return callback(); }
        const currentBranchName = stdout.match(/On branch (\S+)/)[1];
        inquirer.prompt({ type: 'confirm', name: 'moveToMaster', message: 'You are currently on the ' + currentBranchName + ' branch. Move to master before creating new branch?', default: true }).then((answer) => {
          if (answer.moveToMaster) {
            process.stdout.write('> Checking out master branch... ');
            exec('git checkout master');
            console.log('done!');
          }
          callback();
        });
      });
    });
    gitPromise = gitPromise.then(() => {
      return Promise.fromCallback((callback) => {
        exec("[ $(git rev-parse HEAD) = $(git ls-remote $(git rev-parse --abbrev-ref @{u} | sed 's/\// /g') | cut -f1) ] && echo up to date || echo not up to date", (err, stdout, stderr) => {
          if (stdout.startsWith('not up to date')) {
            process.stdout.write('> Your branch is not up to date with the remote. Pulling latest... ');
            exec('git pull');
            console.log('done!');
          }
          exec('git checkout -b ' + branchNameAnswer.branchName);
          callback(null, selectedTicket);
        });
      });
    });
    return gitPromise;
  });
});

// Handle changelog entry.
promise = promise.then((selectedTicket) => {
  return inquirer.prompt({ type: 'confirm', name: 'addChangelog', message: 'Add changelog entry? (attempt to add an entry under the latest version header in the file)', default: prefs.addChangelogEntry }).then((answer) => {
    if (!answer.addChangelog) {
      // If you chose to avoid adding a changelog entry, remember that as the default answer for next time.
      prefs.addChangelogEntry = false;
      return;
    }

    return inquirer.prompt({ type: 'input', name: 'text', message: 'What should the entry say?', default: '* ticket ' + selectedTicket.key.toUpperCase() + ': ' + selectedTicket.summary }).then((changelogEntry) => {
      let filenamePrompt = { type: 'input', name: 'logFilename', message: 'What is the changelog file name?' };
      
      const currentDirectoryPath = path.resolve();
      if (prefs.changelogFilenames && prefs.changelogFilenames[currentDirectoryPath]) {
        filenamePrompt.default = prefs.changelogFilenames[currentDirectoryPath];
        filenamePrompt.message += ' (previously used ' + prefs.changelogFilenames[currentDirectoryPath] + ' for this project)';
      }
      else {
        const filenameGuess = fs.readdirSync('.').find((filename) => { return filename.toLowerCase().startsWith('changelog'); })
        if (filenameGuess) {
          filenamePrompt.default = filenameGuess;
          filenamePrompt.message += ' (I found a file called ' + filenameGuess + ' in the current directory)';
        }
      }
      return inquirer.prompt(filenamePrompt).then((answer) => {
        // Remember the filename for next time.
        if (!prefs.changelogFilenames) {
          prefs.changelogFilenames = {};
        }
        prefs.changelogFilenames[currentDirectoryPath] = answer.logFilename;
        process.stdout.write('> Updating file... ');
        try {
          let changelogContents = fs.readFileSync(answer.logFilename, { encoding: 'utf8' });
          // Find the first occurrence of a version header, and insert the entry in the next line.
          const newFileContent = changelogContents.replace(/\d+\.\d+\.\d+.[^\n]*\n/, (versionHeader) => {
            return versionHeader + changelogEntry.text + '\n';
          });
          fs.writeFileSync(answer.logFilename, newFileContent);
          console.log('done!');
        }
        catch (e) {
          console.log('> Error encountered creating changelog entry, skipping. Error: ', e);
        }
      });
    });
  });
});

promise = promise.then(() => {
  console.log('\nAll done!');
});

promise.catch((err) => {
  const errorMessage = err.message || err;
  if (errorMessage && errorMessage.includes && errorMessage.includes('Unauthorized (401)')) {
    console.log('> Authentication error. Please check your credentials and try again.');
  }
  else {
    console.error(err);
  }
  process.exit(0);
});