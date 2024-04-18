"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const github = __importStar(require("@actions/github"));
const child_process_1 = require("child_process");
const multimatch_1 = __importDefault(require("multimatch"));
class Conflibot {
    constructor() {
        this.token = core.getInput("github-token", { required: true });
        this.octokit = github.getOctokit(this.token);
        this.excludedPaths = core
            .getInput("exclude")
            .split("\n")
            .filter((x) => x !== "");
        core.info(`Excluded paths: ${this.excludedPaths}`);
    }
    setStatus(conclusion = undefined, output = undefined) {
        return __awaiter(this, void 0, void 0, function* () {
            const pr = github.context.payload.pull_request;
            if (!pr)
                throw new Error("The pull request is undefined.");
            const refs = yield this.octokit.rest.checks.listForRef(Object.assign(Object.assign({}, github.context.repo), { ref: pr.head.sha }));
            const current = refs.data.check_runs.find((check) => check.name == "conflibot/details");
            core.debug(`checks: ${JSON.stringify(refs.data)}`);
            core.debug(`current check: ${JSON.stringify(current)}`);
            const params = Object.assign(Object.assign({}, github.context.repo), { name: "conflibot/details", head_sha: pr.head.sha, status: (conclusion ? "completed" : "in_progress"), conclusion,
                output });
            if (current) {
                return this.octokit.rest.checks.update(Object.assign(Object.assign({}, params), { check_run_id: current.id }));
            }
            else {
                return this.octokit.rest.checks.create(params);
            }
        });
    }
    exit(conclusion, reason, summary) {
        core.info(reason);
        this.setStatus(conclusion, {
            title: reason,
            summary: summary || reason,
            text: reason,
        });
    }
    run() {
        return __awaiter(this, void 0, void 0, function* () {
            const remotes = ["origin"];
            try {
                yield this.setStatus();
                const pull = yield this.waitForTestMergeCommit(5, {
                    owner: github.context.issue.owner,
                    repo: github.context.issue.repo,
                    pull_number: github.context.issue.number,
                });
                if (!pull.data.mergeable)
                    return this.exit("neutral", "PR is not mergable");
                const pulls = yield this.octokit.rest.pulls.list(Object.assign(Object.assign({}, github.context.repo), { base: pull.data.base.ref, direction: "asc" }));
                if (pulls.data.length <= 1)
                    return this.exit("success", "No other pulls found.");
                // actions/checkout@v2 is optimized to fetch a single commit by default
                const isShallow = (yield this.system("git rev-parse --is-shallow-repository"))[0].startsWith("true");
                if (isShallow)
                    yield this.system("git fetch --prune --unshallow");
                // actions/checkout@v2 checks out a merge commit by default
                yield this.system(`git checkout ${pull.data.head.ref}`);
                core.info(`First, merging ${pull.data.base.ref} into ${pull.data.head.ref}`);
                yield this.system(`git -c user.name=conflibot -c user.email=dummy@conflibot.invalid merge origin/${pull.data.base.ref} --no-edit`);
                const conflicts = [];
                for (const target of pulls.data) {
                    if (pull.data.head.sha === target.head.sha) {
                        core.info(`Skipping #${target.number} (${target.head.ref})`);
                        continue;
                    }
                    core.info(`Checking #${target.number} (${target.head.ref})`);
                    if (!remotes.includes(target.head.repo.owner.login)) {
                        yield this.system(`git remote add ${target.head.repo.owner.login} ${target.head.repo.url}`);
                    }
                    yield this.system(`git format-patch origin/${pull.data.base.ref}.. ${target.head.repo.owner.login}/${target.head.ref} --stdout | git apply --check`).catch((reason) => {
                        // Patch application error expected.  Throw an error if not.
                        if (!reason.toString().includes("patch does not apply")) {
                            throw reason[2];
                        }
                        const patchFails = [];
                        for (const match of reason[2].matchAll(/error: patch failed: ((.*):\d+)/g)) {
                            if ((0, multimatch_1.default)(match[2], this.excludedPaths).length > 0) {
                                core.info(`Ignoring ${match[2]}`);
                            }
                            else {
                                patchFails.push(match[1]);
                            }
                            core.debug(JSON.stringify(match));
                        }
                        const files = [...new Set(patchFails)]; // unique
                        if (files.length > 0) {
                            conflicts.push([target, files]);
                            core.info(`#${target.number} (${target.head.ref}) has ${files.length} conflict(s)`);
                        }
                    });
                }
                if (conflicts.length == 0)
                    return this.exit("success", "No potential conflicts found!");
                const text = conflicts
                    .map((conflict) => {
                    const branch = conflict[0].head.ref;
                    const sha = conflict[0].head.sha;
                    const baseUrl = `https://github.com/${github.context.repo.owner}/` +
                        `${github.context.repo.repo}`;
                    return (`- #${conflict[0].number} ([${branch}](${baseUrl}/tree/${branch}))\n` +
                        conflict[1]
                            .map((file) => {
                            const match = file.match(/^(.*):(\d)$/);
                            if (!match)
                                return `  - ${file}`;
                            return `  - [${file}](${baseUrl}/blob/${sha}/${match[1]}#L${match[2]})`;
                        })
                            .join("\n"));
                })
                    .join("\n");
                const sum = conflicts.map((c) => c[1].length).reduce((p, c) => p + c);
                const summary = `Found ${sum} potential conflict(s) in ${conflicts.length} other PR(s)!`;
                yield this.setStatus("neutral", { title: summary, summary, text });
            }
            catch (error) {
                this.exit("failure", JSON.stringify(error), "Error!");
            }
        });
    }
    system(command) {
        return new Promise((resolve, reject) => {
            (0, child_process_1.exec)(command, (error, stdout, stderr) => {
                error ? reject([error, stdout, stderr]) : resolve([stdout, stderr]);
            });
        });
    }
    waitForTestMergeCommit(times, pr) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.octokit.rest.pulls.get(pr).then((result) => {
                if (result.data.mergeable !== null)
                    return result;
                if (times == 1)
                    throw "Timed out while waiting for a test merge commit";
                return new Promise((resolve) => setTimeout(() => resolve(this.waitForTestMergeCommit(times - 1, pr)), 1000));
            });
        });
    }
}
new Conflibot().run();
