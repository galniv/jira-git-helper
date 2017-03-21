# jira-git-helper

A simple helper CLI for working with JIRA tickets in combination with git

### To install

Clone repo, enter directory, type `npm install`, then `npm link`.

### To run

Type `jira-helper`.

### Notes

* Preferences are stored encrypted, using the [preferences](https://github.com/caffeinalab/preferences/) module.
* You are only prompted for your JIRA hostname the first time you run the utility. If you made a mistake, delete the config file at `~/.config/preferences/jira-git-helper.pref`.
