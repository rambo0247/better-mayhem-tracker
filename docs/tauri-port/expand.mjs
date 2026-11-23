#!/usr/bin/env node
// Builds plan.md from the parts in src/. Rerun after any edit to a part, then run check-plan.mjs on plan.md.
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const RULE =
	"Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.";
const MODEL = "opus";
const MEDIA = "parity/out/review";

const macros = {
	RULE: () => RULE,
	LIVE: () => `${RULE} Ten lanes on \`${MODEL}\` at the PR head, per the boot recipe.`,
	NOGATE: (id) => `**Review gate.** None. ${id} is not review-gated.`,
	GATE: (id, lanes) =>
		[
			"**Review gate.** The operator reviews before merge.",
			"",
			`- [ ] Copy the lane ${lanes} screenshots into \`${MEDIA}/${id}-review-<slug>.png\`, with the side-by-side image for each.`,
			`- [ ] Record a 30 to 60 second video of the change on a lane machine. Save it as \`${MEDIA}/${id}-review.mp4\`.`,
			"- [ ] Post the screenshots and the video in chat. Stop at STACK-READY. Wait for the operator's go before the unit lands.",
		].join("\n"),
	MERGE: () =>
		[
			"**Merge.**",
			"",
			"- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.",
			"- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.",
			"- [ ] No GitHub pull request exists for the branch.",
			"- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.",
		].join("\n"),
};

const expand = (text) =>
	text.replace(/@@([A-Z]+)(?: ([^@]+))?@@/g, (_, name, args) => {
		const fn = macros[name];
		if (!fn) throw new Error(`unknown macro ${name}`);
		return fn(...(args ? args.split(" ") : []));
	});

const dir = path.join(here, "src");
const parts = fs
	.readdirSync(dir)
	.filter((f) => f.endsWith(".md"))
	.sort()
	.map((f) => fs.readFileSync(path.join(dir, f), "utf8").trimEnd());
fs.writeFileSync(path.join(here, "plan.md"), expand(parts.join("\n\n")) + "\n");
console.log(`wrote plan.md from ${parts.length} parts`);
