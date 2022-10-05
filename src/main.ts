import * as core from "@actions/core";
import * as github from "@actions/github";
import { Context } from "@actions/github/lib/context";
import { GitHub } from "@actions/github/lib/utils";
import type {
  PullRequest,
  PullRequestReviewEvent,
} from "@octokit/webhooks-types";

type GitHubApi = InstanceType<typeof GitHub>;

interface TeamConfiguration {
  description?: string;
  users: string[];
}

interface ReviewerConfiguration {
  description?: string;
  teams?: string[];
  users?: string[];
  requiredApproverCount: number;
}

interface OverrideCriteria {
  description?: string;
  onlyModifiedByUsers?: string[];
  onlyModifiedFileRegExs?: string[];
}

interface Reviewers {
  /** a map of team name to team members */
  teams?: { [key: string]: TeamConfiguration };
  /** a map of path prefix to review requirements */
  reviewers: { [key: string]: ReviewerConfiguration };
  /** criteria that will overrule review requirements */
  overrides?: OverrideCriteria[];
}

async function loadConfig(octokit: GitHubApi, context: Context) {
  core.info("required-reviews.loadConfig 1");
  // The base ref of the PR is avaialble from github.context.payload.pull_request.base.ref
  // If we always want to use that, we can get it directly instead of asking for an extra input
  if (github.context.payload.pull_request) {
    core.info(
      "required-reviews.loadConfig PR base_ref:" +
        github.context.payload.pull_request.base.ref
    );
  }
  const configRef = core.getInput("config-ref");
  // load configuration, note that this call behaves differently than we expect with file sizes larger than 1MB
  const reviewersRequest = await octokit.rest.repos.getContent({
    ...context.repo,
    ref: configRef != "" ? configRef : undefined,
    path: ".github/reviewers.json",
  });
  core.info("required-reviews.loadConfig 2");
  if (!("content" in reviewersRequest.data)) {
    return undefined;
  }
  core.info("required-reviews.loadConfig 3");
  const decodedContent = atob(reviewersRequest.data.content.replace(/\n/g, ""));
  core.info("required-reviews.loadConfig 4");
  return JSON.parse(decodedContent) as Reviewers;
}

function getPrNumber(context: Context): number | undefined {
  if (context.eventName === "pull_request") {
    return (github.context.payload as PullRequest).number;
  } else if (context.eventName === "pull_request_review") {
    return (github.context.payload as PullRequestReviewEvent).pull_request
      .number;
  }
  return undefined;
}

function getPossibleApprovers(
  conf: ReviewerConfiguration,
  teams: { [key: string]: TeamConfiguration }
): Set<string> {
  const namedUsers = conf.users || [];
  const usersFromAllNamedTeams = (conf.teams || [])
    .map((team) => teams[team].users)
    .reduce((left, right) => [...left, ...right], []);
  return new Set([...namedUsers, ...usersFromAllNamedTeams]);
}

// note that this will truncate at >3000 files
async function getModifiedFilepaths(
  octokit: GitHubApi,
  context: Context,
  prNumber: number
) {
  const allPrFiles = await octokit.rest.pulls.listFiles({
    ...context.repo,
    pull_number: prNumber,
  });
  return allPrFiles.data.map((file) => file.filename);
}

async function getApprovals(
  octokit: GitHubApi,
  context: Context,
  prNumber: number
) {
  const prReviews = await octokit.rest.pulls.listReviews({
    ...context.repo,
    pull_number: prNumber,
  });

  core.info("getApprovals PR Reviews:" + JSON.stringify(prReviews.data));

  // The reviews are in chronological order so we just need to use the latest state
  const reviewStatus: { [key: string]: string } = {};
  prReviews.data.forEach((review) => {
    // COMMENTED reviews do not affect the approval state
    if (review.user !== null && review.state != "COMMENTED") {
      reviewStatus[review.user.login] = review.state;
    }
  });

  const approvals = [];
  for (const login in reviewStatus) {
    if (reviewStatus[login] == "APPROVED") approvals.push(login);
  }

  return approvals;
}

async function getCommiters(
  octokit: GitHubApi,
  context: Context,
  prNumber: number
) {
  // capped at 250 commits
  const commits = await octokit.rest.pulls.listCommits({
    ...context.repo,
    pull_number: prNumber,
  });

  return commits.data.map((commit) => commit.committer?.login);
}

export function check(
  reviewersConfig: Reviewers,
  modifiedFilepaths: string[],
  approvals: string[],
  infoLog: (message: string) => void,
  warnLog: (message: string) => void
) {
  let approved = true;
  for (const prefix in reviewersConfig.reviewers) {
    // find files that match the rule
    const affectedFiles = modifiedFilepaths.filter((file) =>
      file.startsWith(prefix)
    );

    if (affectedFiles.length > 0) {
      // evaluate rule
      const reviewRequirements = reviewersConfig.reviewers[prefix];
      const possibleApprovers = getPossibleApprovers(
        reviewersConfig.reviewers[prefix],
        reviewersConfig.teams || {}
      );

      const relevantApprovals = approvals.filter((user) =>
        possibleApprovers.has(user)
      );
      const count = relevantApprovals.length;

      if (count < reviewRequirements.requiredApproverCount) {
        warnLog(
          "Modified Files:\n" +
            affectedFiles.map((f) => ` - ${f}\n`) +
            `Require ${reviewRequirements.requiredApproverCount} reviews from:\n` +
            "  users:" +
            (reviewRequirements.users
              ? "\n" + reviewRequirements.users.map((u) => ` - ${u}\n`)
              : " []\n") +
            "  teams:" +
            (reviewRequirements.teams
              ? "\n" + reviewRequirements.teams.map((t) => ` - ${t}\n`)
              : " []\n") +
            `But only found ${count} approvals: ` +
            `[${relevantApprovals.join(", ")}].`
        );
        approved = false;
      } else {
        infoLog(`${prefix} review requirements met.`);
      }
    }
  }
  return approved;
}

/** returns true if at least one OverrideCriteria is satisfied. */
export function checkOverride(
  overrides: OverrideCriteria[],
  modifiedFilePaths: string[],
  modifiedByUsers: (string | undefined)[]
) {
  return overrides.some((crit) => {
    let maybe = true;
    if (crit.onlyModifiedByUsers !== undefined) {
      const testSet = new Set(crit.onlyModifiedByUsers);
      maybe =
        maybe &&
        modifiedByUsers.every(
          (user) => user !== undefined && testSet.has(user)
        );
    }
    if (crit.onlyModifiedFileRegExs !== undefined) {
      maybe =
        maybe &&
        modifiedFilePaths.every((modifiedFile) =>
          crit.onlyModifiedFileRegExs?.some((pattern) =>
            new RegExp(pattern).test(modifiedFile)
          )
        );
    }
    return maybe;
  });
}

async function run(): Promise<void> {
  core.info("required-reviews.run.1");
  core.info(
    "full github.context.payload:" + JSON.stringify(github.context.payload)
  );

  try {
    const authToken = core.getInput("github-token");
    const postReview = core.getInput("post-review") === "true";
    const octokit = github.getOctokit(authToken);
    const context = github.context;

    const prNumber = getPrNumber(context);
    if (prNumber === undefined) {
      core.setFailed(
        `Action invoked on unexpected event type '${github.context.eventName}'`
      );
      return;
    }

    core.info("required-reviews.run.3");

    const reviewersConfig = await loadConfig(octokit, context);
    if (!reviewersConfig) {
      core.setFailed("Unable to retrieve .github/reviewers.json");
      return;
    }

    core.info("required-reviews.run.4");

    const modifiedFilepaths = await getModifiedFilepaths(
      octokit,
      context,
      prNumber
    );
    const approvals = await getApprovals(octokit, context, prNumber);
    const committers = await getCommiters(octokit, context, prNumber);

    core.info("required-reviews.run.5");

    const approved = check(
      reviewersConfig,
      modifiedFilepaths,
      approvals,
      core.info,
      core.warning
    );

    core.info("required-reviews.run.6");

    if (!approved) {
      const override =
        reviewersConfig.overrides !== undefined &&
        checkOverride(reviewersConfig.overrides, modifiedFilepaths, committers);
      if (!override) {
        if (postReview) {
          await octokit.rest.pulls.createReview({
            ...context.repo,
            pull_number: prNumber,
            event: "REQUEST_CHANGES",
            body: "Missing required reviewers",
          });
        } else {
          core.setFailed("Missing required approvals.");
        }
        return;
      }
      // drop through
      core.info("Missing required approvals but allowing due to override.");
    }
    core.info("required-reviews.run.7");
    // pass
    if (postReview) {
      await octokit.rest.pulls.createReview({
        ...context.repo,
        pull_number: prNumber,
        event: "APPROVE",
        body: "All review requirements have been met",
      });
    }
    core.info("required-reviews.run.8");
    core.info("All review requirements have been met");
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    }
  }
}

run();
