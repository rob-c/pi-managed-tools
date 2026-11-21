---
name: busybox-applets
description: "All 236 BusyBox applets with a read-only vs mutating classification: which applets never change anything, which write, which are destructive or system-level, and which flags cause the write. Load before running any busybox applet that is not obviously an inspection command."
---

# BusyBox applets

`busybox <applet> [args]` — 236 applets inside one static binary (v1.39.0).
BusyBox dispatches on **argv[0]**, so the installed file must stay named `busybox`;
if you copy or rename it, `busybox` no longer works and the new name is treated as
the applet name.

**Never run `busybox --install -s <dir>`.** Inside pi's bin directory — which is
first on `PATH` for every bash command — that would create 236 symlinks ahead of the
real coreutils, and busybox `sed`, `grep`, `find`, `tar`, `awk` and `xxd` are not
GNU-compatible. Every later command in the session, including the other tools in
this package, would silently change behaviour.

Prefer the dedicated tools where they exist: `rg` over `busybox grep`, `fd` over
`busybox find`, `bat` over `busybox cat`, `jq` over `busybox awk`, `diff`/`difft`
over `busybox diff`, `scc` over `busybox wc`-loops. Use busybox for the applets
nothing else covers (`hexdump`, `xxd`, `unzip`, `gzip`, `patch`, `cpio`, `dpkg-deb`,
`date`, `hostname`, `sha*sum`).

Legend: **R** never changes state · **M** writes files or state · **M★**
destructive, irreversible or system-level · **E** runs a program you name, so its
effect is whatever that program does.

## Read-only (R)

Safe for inspection. These only read input and write to stdout/stderr.

```
[ [[ arch ascii base32 base64 basename bc blkid bzcat cal cat chat cksum clear cmp
comm crc32 cut dc df diff dirname dnsdomainname du echo egrep expand expr factor
false fgconsole fgrep fold getopt grep groups hd head hexdump hostid id iostat ipcalc
join less logname ls lsattr lsof lspci lsscsi lsusb lzcat man md5sum mkpasswd more
mountpoint mpstat netstat nl nmeter nologin nproc nslookup od paste pipe_progress
printenv printf pscan pwd pwdx readlink realpath resize rev rpm2cpio scriptreplay
seq sha1sum sha256sum sha384sum sha3sum sha512sum sleep stat strings sum svok tac
tail test tr tree true ts tsort tty ttysize uname unexpand usleep uuencode uuidgen
vmstat volname wc which whoami whois xxd xzcat yes zcat
```

Two caveats inside "read-only": `busybox xxd -r` only prints (it cannot write back),
and `busybox find` is read-only **only** with its default `-print`.

## Writes files or state (M)

| applet | what it writes | how |
|---|---|---|
| `add-shell` | `/etc/shells` | appends each argument |
| `awk` | files anywhere | `print > file`, `>> file`, `system()` |
| `bootchartd` | `/var/log/bootchart.tgz` | `start`, `stop`, `init` |
| `chattr` | inode attributes | `-,+,=attr`, `-R` |
| `chgrp` `chmod` `chown` | ownership and mode bits | normal form, `-R` |
| `dos2unix` | the file, in place | any file argument |
| `dpkg-deb` | extracted tree | `-e DIR`, `-x DIR`, `-X DIR` |
| `fatattr` | FAT attributes | `-/+rhsvda` |
| `flock` | lock file (created if absent) | `FILE`, `FILE -c PROG` |
| `fsync` | flushes blocks (no content change) | any file argument |
| `link` | new hard link | `FILE LINK` |
| `ln` | links; removes an existing target | `-f`, `-b` |
| `logger` | syslog | always writes |
| `lpr` | print queue | any file argument |
| `mesg` | terminal write permission | `y` / `n` |
| `mkdir` `mkfifo` `mknod` `mktemp` | new filesystem entries | normal form, `-p`, `-m` |
| `nc` | hex-dump file | `-o FILE` |
| `nohup` | `nohup.out` | when stdout is a tty |
| `remove-shell` | `/etc/shells` | rewrites it |
| `renice` | nice values of running processes | `PRIORITY ID`, `-p/-g/-u` |
| `run-parts` | whatever the scripts do | `DIRECTORY` |
| `rx` | received file | `FILE` |
| `script` | `typescript` + timing file | `OUTFILE`, `-a` |
| `sed` | files in place | `-i[SFX]` — without it, stdout only |
| `shuf` `sort` | output file | `-o FILE` (default stdout) |
| `split` | `PREFIX*` output files | `INPUT PREFIX`, `-b`, `-l` |
| `time` | result file | `-o FILE`, `-a` |
| `touch` | creates/updates timestamps | any file argument |
| `uniq` | truncated output file | second positional `OUTFILE` |
| `unix2dos` | the file, in place | any file argument |
| `uudecode` | output file | `-o FILE` |
| `wget` | downloads into cwd | `URL`, `-O FILE`, `-P DIR` |
| `fakeidentd` | network service | daemon mode |

## Destructive or system-level (M★)

Deletes, overwrites, truncates, formats, kills, mounts, or changes the machine.
Confirm before running any of these.

| applet | what it destroys or changes | how |
|---|---|---|
| `rm` `rmdir` `unlink` | deletes files / empty dirs | `-r`, `-f`, `-p` |
| `mv` | overwrites destination | `-f` |
| `cp` | overwrites destination | `-f`, `-r`, `-a` |
| `dd` | block device or file, truncated | `of=`, `seek=`, `conv=notrunc` |
| `truncate` | truncates and creates | `-s SIZE` (`-c` only stops creation) |
| `shred` | overwrites then deletes | `-n`, `-z`, `-u` |
| `tee` | truncates every file named | any file arg (`-a` appends) |
| `tar` | creates/extracts, overwrites | `c`, `x`, `-C DIR` (`t` only lists) |
| `unzip` `unxz` `unlzma` `gunzip` `xz` `gzip` `bzip2` `bunzip2` `lzma` `lzop` | write output and **delete the input** unless `-k` | `-f` forces overwrite; `-c`/`-t` are read-only |
| `patch` | rewrites targets in place | `-i DIFF`, `ORIGFILE` |
| `ed` `vi` `hexedit` | overwrite the file on save | file argument (`vi -R` is read-only) |
| `kill` `killall` `killall5` | terminate processes | `-SIG PID`, name |
| `timeout` | signals the child | `-s`, `-k` |
| `start-stop-daemon` `svc` | start/kill supervised processes | `-S`, `-K`, `-u -d -o` |
| `date` `rdate` `hwclock` | set the system clock | `-s`, `-w`, `--systz` |
| `hostname` | system hostname | `HOSTNAME`, `-F` (`-s/-i/-d` read) |
| `sysctl` | kernel parameters | `-w`, `-p`, `KEY=VALUE` |
| `stty` | terminal/device settings | any setting arg (`-a`, `-g` read) |
| `devmem` `setconsole` `setkeycodes` `chvt` `deallocvt` `resume` `swaplabel` `fdformat` `fbset` `makedevs` `rtcwake` | devices, kernel maps, consoles, RTC alarm and sleep state | positional args, `-s SEC`, `-t TIME` |
| `microcom` `getty` | writes to a serial/tty device | `TTY` |
| `dpkg` `rpm` | install/remove packages system-wide | `-i`, `-r`, `-P` |
| `chroot` | changes root, runs `PROG` | `NEWROOT PROG` |
| `install` | copies and overwrites, sets owner/mode | always writes |
| `cpio` | extracts or creates archives | `-i`, `-o -F`, `-p DIR` |
| `fatlabel` | FAT label on a block device | `BLOCKDEV LABEL` |
| `ftpd` `ftpput` `ftpget` `tftpd` `tftp` `telnet` `telnetd` `httpd` `inetd` `ssl_server` `tcpsvd` `udpsvd` | serve, upload or run remote-triggered commands | server/upload modes |
| `find` | deletes or runs commands | `-delete`, `-exec CMD ;` |
| `mim` | runs shell commands from a spec | `-f FILE` |
| `ash` `sh` `hush` | anything the script does | `-c SCRIPT`, script file |
| `sync` | flushes all buffers | no flags needed |
| `lpq` | cancels print jobs | `-d JOBID` |
| `lpd` | spool queue files | always writes |
| `getty` | utmp/wtmp, login | `TTY` |

## Runs a program you name (E)

Read-only *by themselves*; the effect is entirely the child's. `env`, `envdir`,
`nice`, `setsid`, `cttyhack`, `xargs` (`-a FILE` only reads), plus `find -exec`,
`awk system()`, `sed e`, `tar --to-command`, `vi !cmd`.

## BusyBox is not GNU

Before reaching for an applet that shadows a GNU tool, remember the flag gaps:
`grep` has no `-P`, `find` has no `-printf`, `sed -i` exists but `sed` lacks many
GNU extensions, `tar` has no `--exclude-from` in the same form, `xxd` accepts one
FILE, `ls` has no `--color=auto` nuance. When the GNU-compatible tool exists in
this package (`rg`, `fd`, `bat`, `jq`, `scc`, `difft`), use it instead.
