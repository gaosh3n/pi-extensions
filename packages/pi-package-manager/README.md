# pi-package-manager

`pi-package-manager` keeps your Pi packages up-to-date and shows you what happened, right inside Pi.

## What you get

- automatic package update checks when Pi starts
- a visible progress UI while Pi checks or updates packages
- `/package-manager status` to see whether updates are available
- `/package-manager update` to run the update flow on demand
- `/package-manager install` to install a Pi package from an entered source
- `/package-manager install-via-catalog` to search discoverable npm Pi packages and install one with confirmation
- `/package-manager uninstall` to remove one or more installed Pi packages from a checkbox-style picker
- a final result card in Pi so you can review the latest outcome
- automatic Pi reload after a successful startup update

## Install only this extension

```bash
pi install npm:@gaosh3n/pi-package-manager
```

Then restart Pi or run `/reload`.

## How to use it

### Let it run on startup

Start Pi normally. If package updates are available, Pi Package Manager checks for them, shows progress in Pi, and reports the result when it finishes.

### Check package status

Run:

```text
/package-manager status
```

You will get a status card in Pi showing whether updates are available and summarizing the latest package update result.

### Run a package update

Run:

```text
/package-manager update
```

Pi will run the update flow for you, show live progress, and record the final result in the transcript.

### Install a package

Run:

```text
/package-manager install
```

Pi will prompt you for a package source such as `npm:@foo/bar` or `git:github.com/user/repo`, run the native `pi install ...` flow, and show a final result card. After a successful install, run `/reload` to activate the installed package resources.

### Install from the package catalog

Run:

```text
/package-manager install-via-catalog
```

The catalog searches npm packages carrying the `pi-package` keyword. Use the search input, type filter, and sort selector; press Tab or Shift+Tab to move focus. The command uses bounded npm JSON requests and may show a partial-results warning when package metadata cannot be resolved. It classifies packages from explicit `package.json.pi` declarations and does not scrape `pi.dev` HTML or inspect package tarballs. Review the package details and confirm before installation. After a successful install, run `/reload` to activate the installed resources.

### Uninstall package(s)

Run:

```text
/package-manager uninstall
```

Pi will show a checkbox-style package picker. Use <space> to toggle package selection, then press Enter to confirm. Pi runs native `pi uninstall <source>` once per selected package and shows one final result card. After successful or partial removal, run `/reload` to deactivate removed package resources.
