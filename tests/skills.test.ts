/**
 * The skills are shipped documentation, so they drift silently. These tests tie
 * them to the registry: a tool added without a mention fails here, and a
 * description that breaks the Agent Skills limit fails here too.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { MANAGED_TOOLS, MANAGED_TOOL_IDS } from "../src/tools.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SHORT = "managed-tools";
const REFERENCE = "managed-tools-reference";

function readSkill(name: string): { frontmatter: Record<string, string>; body: string } {
	const path = join(ROOT, "skills", name, "SKILL.md");
	assert.ok(existsSync(path), `missing ${path}`);
	const text = readFileSync(path, "utf-8");
	const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	assert.ok(match, `${name}/SKILL.md has no frontmatter block`);
	const frontmatter: Record<string, string> = {};
	for (const line of (match[1] as string).split("\n")) {
		const field = line.match(/^([a-z-]+):\s*(.*)$/);
		if (!field) continue;
		frontmatter[field[1] as string] = (field[2] as string).replace(/^"|"$/g, "").trim();
	}
	return { frontmatter, body: match[2] as string };
}

describe("skills", () => {
	test("every skill is discoverable, named after its directory and within the limit", () => {
		const dirs = readdirSync(join(ROOT, "skills"), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
		assert.deepEqual(dirs.sort(), [REFERENCE, "busybox-applets", SHORT].sort());
		for (const name of dirs) {
			const { frontmatter } = readSkill(name);
			assert.equal(frontmatter.name, name);
			const description = frontmatter.description ?? "";
			assert.ok(description.length > 40, `${name} description is too vague to route on`);
			assert.ok(description.length <= 1024, `${name} description exceeds 1024 chars`);
		}
	});

	test("both tool skills are discoverable and named after their directory", () => {
		for (const name of [SHORT, REFERENCE]) {
			const { frontmatter } = readSkill(name);
			assert.equal(frontmatter.name, name);
		}
	});

	test("descriptions fit the Agent Skills limit and carry routing information", () => {
		for (const name of [SHORT, REFERENCE]) {
			const { frontmatter } = readSkill(name);
			const description = frontmatter.description ?? "";
			assert.ok(description.length > 40, `${name} description is too vague to route on`);
			assert.ok(description.length <= 1024, `${name} description exceeds 1024 chars`);
		}
		// The short skill is the always-advertised one, so it must point at the detail.
		assert.match(readSkill(SHORT).frontmatter.description ?? "", new RegExp(REFERENCE));
	});

	test("the always-on description pushes rtk first, then this toolkit", () => {
		const description = readSkill(SHORT).frontmatter.description ?? "";
		assert.match(description, /prefer/i);
		assert.ok(description.includes("rtk"), "the always-on text must name rtk");
		// Order is the policy: shrink output first, then replace system binaries.
		assert.ok(
			description.indexOf("rtk") < description.indexOf("rg"),
			"rtk must be presented before the other tools",
		);
	});

	test("both skills separate a verdict from content", () => {
		// rtk summarises: rtk git diff reduces a diff to a file list. Instructing a
		// model to compress content it must read would break edits, so both skills
		// have to make the distinction explicit.
		for (const body of [readSkill(SHORT).body, readSkill(REFERENCE).body]) {
			assert.match(body, /verdict/i);
			assert.match(body, /content/i);
			assert.match(body, /diff/i);
		}
	});

	test("the always-on skill names every managed tool", () => {
		const text = readFileSync(join(ROOT, "skills", SHORT, "SKILL.md"), "utf-8");
		for (const id of MANAGED_TOOL_IDS) {
			assert.ok(text.includes(id), `${SHORT} never mentions ${id}`);
		}
	});

	test("the reference documents every managed tool, with examples", () => {
		const { body } = readSkill(REFERENCE);
		for (const id of MANAGED_TOOL_IDS) {
			assert.ok(body.includes(`## ${id} `), `${REFERENCE} has no section for ${id}`);
		}
		// One runnable block per tool keeps the file honest rather than aspirational.
		const blocks = body.match(/```bash\n[\s\S]*?```/g) ?? [];
		assert.ok(
			blocks.length >= MANAGED_TOOL_IDS.length,
			`expected at least ${MANAGED_TOOL_IDS.length} example blocks, found ${blocks.length}`,
		);
	});

	test("the busybox skill documents all 236 applets with R/M/M* categories", () => {
		const path = join(ROOT, "skills", "busybox-applets", "SKILL.md");
		assert.ok(existsSync(path), "missing the busybox-applets skill");
		const text = readFileSync(path, "utf-8");
		const roster = `[ [[ add-shell arch ascii ash awk base32 base64 basename bc blkid bootchartd bunzip2 bzcat bzip2 cal cat chat chattr chgrp chmod chown chroot chvt cksum clear cmp comm cp cpio crc32 cttyhack cut date dc dd deallocvt devmem df diff dirname dnsdomainname dos2unix dpkg dpkg-deb du echo ed egrep env envdir expand expr factor fakeidentd false fatattr fatlabel fbset fdformat fgconsole fgrep find flock fold fsync ftpd ftpget ftpput getopt getty grep groups gunzip gzip hd head hexdump hexedit hostid hostname httpd hush hwclock id inetd install iostat ipcalc join kill killall killall5 less link ln logger logname lpd lpq lpr ls lsattr lsof lspci lsscsi lsusb lzcat lzma lzop makedevs man md5sum mesg microcom mim mkdir mkfifo mknod mkpasswd mktemp more mountpoint mpstat mv nc netstat nice nl nmeter nohup nologin nproc nslookup od paste patch pipe_progress printenv printf pscan pwd pwdx rdate readlink realpath remove-shell renice resize resume rev rm rmdir rpm rpm2cpio rtcwake run-parts rx script scriptreplay sed seq setconsole setkeycodes setsid sh sha1sum sha256sum sha384sum sha3sum sha512sum shred shuf sleep sort split ssl_server start-stop-daemon stat strings stty sum svc svok swaplabel sync sysctl tac tail tar tcpsvd tee telnet telnetd test tftp tftpd time timeout touch tr tree true truncate ts tsort tty ttysize udpsvd uname unexpand uniq unix2dos unlink unlzma unxz unzip usleep uudecode uuencode uuidgen vi vmstat volname wc wget which whoami whois xargs xxd xz xzcat yes zcat`.split(" ");
		assert.equal(roster.length, 236, "applet roster should list all 236");
		// Word-set membership, so `ls` inside `lsof` cannot satisfy the check.
		const words = new Set(text.match(/[A-Za-z0-9_.-]+/g) ?? []);
		for (const applet of roster) {
			if (applet === "[" || applet === "[[") continue;
			assert.ok(words.has(applet), `busybox-applets does not document ${applet}`);
		}
		assert.ok(text.includes("[ [["), "the bracket applets are not listed");
		for (const marker of ["**R**", "**M**", "**M★**", "busybox --install -s"]) {
			assert.ok(text.includes(marker), `busybox-applets is missing ${marker}`);
		}
	});

	test("both skills list the same version banner", () => {
		const short = readFileSync(join(ROOT, "skills", SHORT, "SKILL.md"), "utf-8");
		const reference = readSkill(REFERENCE).body;
		const versions = (text: string) =>
			[...text.matchAll(/\b([a-z-]+) (\d+\.\d+\.\d+)/g)]
				.map((match) => `${match[1]}@${match[2]}`)
				.filter((entry) => MANAGED_TOOL_IDS.some((id) => entry.startsWith(`${id}@`)))
				.sort();
		assert.deepEqual(versions(short), versions(reference));
		assert.equal(versions(short).length, MANAGED_TOOL_IDS.length);
	});

	test("the mutation map covers every managed tool, read-only and mutating", () => {
		// A new tool must ship with a row saying what can change state; a wrong or
		// missing entry here is how an agent deletes something by accident.
		const body = readSkill(REFERENCE).body;
		const start = body.indexOf("## Read-only vs mutating");
		assert.ok(start >= 0, "the reference has no mutation map section");
		const section = body.slice(start, body.indexOf("\n## ", start + 10));
		for (const id of MANAGED_TOOL_IDS) {
			const label = MANAGED_TOOLS[id].binaryName;
			// The row is labelled with whichever name an agent would actually type.
			const row = section
				.split("\n")
				.find((line) => line.startsWith(`| ${id} |`) || line.startsWith(`| ${label} |`));
			assert.ok(row, `the mutation map has no row for ${id} (${label})`);
			const cells = (row as string).split("|").filter((cell) => cell.trim().length > 0);
			assert.equal(cells.length, 3, `${id} row must have tool, read-only and mutates cells`);
			assert.ok((cells[1] as string).trim().length > 3, `${id} row has no read-only statement`);
			assert.ok((cells[2] as string).trim().length > 3, `${id} row has no mutating statement`);
		}
	});

	test("the reference does not advertise a tool the registry does not manage", () => {
		const { body } = readSkill(REFERENCE);
		const sections = [...body.matchAll(/^## ([a-z-]+) /gm)].map((match) => match[1] as string);
		for (const section of sections) {
			assert.ok(
				MANAGED_TOOL_IDS.includes(section as never),
				`${REFERENCE} documents ${section}, which is not in MANAGED_TOOL_IDS`,
			);
		}
		assert.equal(sections.length, MANAGED_TOOL_IDS.length);
		// tree has no release assets, so it must stay out of both skills.
		assert.equal(/"tree"/.test(JSON.stringify(MANAGED_TOOLS)), false);
	});
});
