const core = require('@actions/core');
const github = require('@actions/github');
const config = require('./config');
const {
  githubContext,
  input: { githubToken, label },
} = config;
const octokit = github.getOctokit(githubToken);

// use the unique label to find the runner
// as we don't have the runner's id, it's not possible to get it in any other way
async function getRunner(label) {
  try {
    const runners = await octokit.paginate('GET /repos/{owner}/{repo}/actions/runners', githubContext);
    return runners.find((runner) => runner.labels[0].name === label) || null;
  } catch (error) {
    return null;
  }
}

// get GitHub Registration Token for registering a self-hosted runner
async function getRegistrationToken() {
  try {
    const response = await octokit.request('POST /repos/{owner}/{repo}/actions/runners/registration-token', githubContext);
    core.info('GitHub Registration Token is received');
    return response.data.token;
  } catch (error) {
    core.error('GitHub Registration Token receiving error');
    throw error;
  }
}

async function removeRunner() {
  const runner = await getRunner(label);

  // skip the runner removal process if the runner is not found
  if (!runner) {
    core.info(`GitHub self-hosted runner with label ${label} is not found, so the removal is skipped`);
    return;
  }

  try {
    await octokit.request('DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}', { ...githubContext, runner_id: runner.id });
    core.info(`GitHub self-hosted runner ${runner.name} is removed`);
  } catch (error) {
    core.error('GitHub self-hosted runner removal error');
    throw error;
  }
}

async function waitForRunnerRegistered(label) {
  const timeoutMinutes = 5;
  const retryIntervalSeconds = 10;
  const quietPeriodSeconds = 30;
  let waitSeconds = 0;

  core.info(`Waiting ${quietPeriodSeconds}s for the AWS EC2 instance to be registered in GitHub as a new self-hosted runner`);
  await new Promise((r) => setTimeout(r, quietPeriodSeconds * 1000));
  core.info(`Checking every ${retryIntervalSeconds}s if the GitHub self-hosted runner is registered`);

  return new Promise((resolve, reject) => {
    const interval = setInterval(async () => {
      const runner = await getRunner(label);
      if (runner && runner.status === 'online') {
        core.info(`GitHub self-hosted runner ${runner.name} is registered and ready to use`);
        clearInterval(interval);
        resolve();
      } else if (waitSeconds > timeoutMinutes * 60) {
        core.error('GitHub self-hosted runner registration error');
        clearInterval(interval);
        reject(
          `A timeout of ${timeoutMinutes} minutes is exceeded. Your AWS EC2 instance was not able to register itself in GitHub as a new self-hosted runner.`,
        );
      } else {
        waitSeconds += retryIntervalSeconds;
        core.info('Checking...');
      }
    }, retryIntervalSeconds * 1000);
  });
}

module.exports = {
  getRegistrationToken,
  removeRunner,
  waitForRunnerRegistered,
};
