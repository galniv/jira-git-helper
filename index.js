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
  addChangelogEntry: true,
  changelogFilenames: {}
});

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

// The first time the utility is run, ask for the JIRA hostname.
promise = Promise.try(() => {
  if (prefs.jiraHost) { return; }

  return inquirer.prompt({ name: 'host', message: 'What is your JIRA hostname? (e.g. company.atlassian.net)' }).then((answer) => {
    prefs.jiraHost = answer.host;
  });
});

var jiraClient;
// Get the user's credentials.
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
        callback(null, boards[answers.boardName].id);
      });
    });
  });
});

// Get the active sprint.
promise = promise.then((boardId) => {
  prefs.agileBoardId = boardId;
  return Promise.fromCallback((callback) => {
    jiraClient.board.getSprintsForBoard({ boardId: boardId, state: 'active' }, (err, result) => {
      if (err) { return callback(err); }

      // Error if there are no active springs (for now).
      if (!result.values || result.values.length === 0) {
        return callback("No active sprints found for the selected board!");
      }

      // Assume there's only a single active sprint per board.
      // TODO: is this always a valid assumption?
      callback(null, result.values[0]);
    });
  });
});

// Get issues.
promise = promise.then((activeSprint) => {
  return Promise.fromCallback((callback) => {
    jiraClient.search.search({
      jql: 'assignee = "' + prefs.email + '" AND status in (New, "In Progress") AND Sprint = "' + activeSprint.name + '"',
      fields: [ 'key', 'project', 'created', 'priority', 'reporter', 'sprint', 'status', 'summary' ]
    }, (err, searchResults) => {
      if (err) { return callback(err); }
      console.log(searchResults, 'assignee = "' + prefs.email + '" AND status in (New, "In Progress") AND Sprint = "' + activeSprint.name + '"')
      // Error if there are no new issues.
      if (searchResults.total === 0) {
        return callback("No New or In Progress issues found in the current sprint!");
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

// Choosen ticket.
promise = promise.then((issueChoices) => {
  return inquirer.prompt({ type: 'list', name: 'issue', message: 'Which ticket are you starting to work on?', choices: issueChoices });
});

// Offer to transition New ticket to In Progress.
promise = promise.then((chosenTicket) => {
  if (chosenTicket.issue.status !== 'New') { return chosenTicket.issue; }
  return inquirer.prompt({ type: 'confirm', name: 'moveTicket', message: 'Transition ticket status to In Progress?', default: true }).then((answer) => {
    if (!answer.moveTicket) { return chosenTicket.issue; }

    return Promise.fromCallback((callback) => {
      jiraClient.issue.transitionIssue({ issueId: chosenTicket.issue.id, transition: { id: 11 } }, (err, result) => {
        if (err) { return callback(err); }

        console.log('\t...done!');
        callback(null, chosenTicket.issue);
      })
    });
  });
});

// Choose branch name, ask to move to master branch, pull latest.
promise = promise.then((chosenTicket) => {
  return inquirer.prompt({ type: 'input', name: 'branchName', message: 'What would you like to name the branch?', default: chosenTicket.key.toLowerCase() + '-' + _.kebabCase(chosenTicket.summary) }).then((branchNameAnswer) => {
    gitPromise = Promise.fromCallback((callback) => {
      exec('git status', (err, stdout, stderr) => {
        console.log(stdout.startsWith('On branch master'), stdout);
        if (stdout.startsWith('On branch master')) { return callback(); }

        inquirer.prompt({ type: 'confirm', name: 'moveToMaster', message: 'You are not on the master branch. Move to master before branching?', default: true }).then((answer) => {
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
          callback(null, chosenTicket);
        });
      });
    });
    return gitPromise;
  });
});

// Handle changelog entry.
promise = promise.then((chosenTicket) => {
  return inquirer.prompt({ type: 'confirm', name: 'addChangelog', message: 'Add changelog entry? (attempt to add an entry under the latest version header in the file)', default: prefs.addChangelogEntry }).then((answer) => {
    if (!answer.addChangelog) {
      // If you chose to avoid adding a changelog entry, remember that as the default answer for next time.
      prefs.addChangelogEntry = false;
      return;
    }

    return inquirer.prompt({ type: 'input', name: 'text', message: 'What should the entry say?', default: '* ticket ' + chosenTicket.key.toUpperCase() + ': ' + chosenTicket.summary }).then((changelogEntry) => {
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
  if (errorMessage.includes('Unauthorized (401)')) {
    console.log('> Authentication error. Please check your credentials and try again.');
  }
  else {
    console.error(err);
  }
  process.exit(0);
});