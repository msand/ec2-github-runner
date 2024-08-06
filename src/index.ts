import {
  _InstanceType,
  EC2,
  RunInstancesCommandInput,
  TagSpecification,
  waitUntilInstanceRunning,
} from '@aws-sdk/client-ec2';
import * as core from '@actions/core';
import * as github from '@actions/github';
import filter from 'lodash/filter';

function err(message: string) {
  const err = new Error(message);
  core.error(err);
  core.setFailed(message);
  throw err;
}

//
// validate input
//

const mode = core.getInput(`mode`);
if (!mode) {
  err(`The mode input is not specified`);
}

const githubToken = core.getInput(`github-token`);
if (!githubToken) {
  err(`The github-token input is not specified`);
}

const ec2Params: RunInstancesCommandInput | null = JSON.parse(core.getInput(`ec2-params`));
const ec2ImageId = core.getInput(`ec2-image-id`);
const ec2InstanceType = core.getInput(`ec2-instance-type`) as _InstanceType;
const securityGroupId = core.getInput(`security-group-id`);
const subnetId = core.getInput(`subnet-id`);

const label = core.getInput(`label`);
const ec2InstanceId = core.getInput(`ec2-instance-id`);

if (mode === `start`) {
  if (!ec2Params && (!ec2ImageId || !ec2InstanceType || !subnetId || !securityGroupId)) {
    err(`Not all the required inputs are provided for the start mode`);
  }
} else if (mode === `stop`) {
  if (!label || !ec2InstanceId) {
    err(`Not all the required inputs are provided for the stop mode`);
  }
} else {
  err(`Wrong mode. Allowed values: start, stop.`);
}

const keyName = core.getInput(`key-name`);
const storagePath = core.getInput(`storage-path`);
const storageSize = core.getInput(`storage-size`);
const iamRoleName = core.getInput(`iam-role-name`);
const runnerHomeDir = core.getInput(`runner-home-dir`);
const preRunnerScript = core.getInput(`pre-runner-script`);

const tags = JSON.parse(core.getInput(`aws-resource-tags`));
const tagSpecifications: TagSpecification[] | undefined =
  tags.length === 0
    ? undefined
    : [
        {
          ResourceType: `instance`,
          Tags: tags,
        },
        { ResourceType: `volume`, Tags: tags },
      ];

const octokit = github.getOctokit(githubToken);

// the values of github.context.repo.owner and github.context.repo.repo are taken from
// the environment variable GITHUB_REPOSITORY specified in "owner/repo" format and
// provided by the GitHub Action on the runtime
const { owner, repo } = github.context.repo;
const githubContext = {
  owner: owner,
  repo: repo,
};

// User data scripts are run as the root user
function buildUserDataScript(label: string, githubRegistrationToken: string) {
  return runnerHomeDir
    ? `#!/bin/bash
cd "${runnerHomeDir}"
echo "${preRunnerScript}" > pre-runner-script.sh
source pre-runner-script.sh
export RUNNER_ALLOW_RUNASROOT=1
./config.sh --url https://github.com/${owner}/${repo} --token ${githubRegistrationToken} --labels ${label}
./run.sh
`
    : `#!/bin/bash
mkdir actions-runner && cd actions-runner
echo "${preRunnerScript}" > pre-runner-script.sh
source pre-runner-script.sh
case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=\${ARCH}
curl -O -L https://github.com/actions/runner/releases/download/v2.313.0/actions-runner-linux-\${RUNNER_ARCH}-2.313.0.tar.gz
tar xzf ./actions-runner-linux-\${RUNNER_ARCH}-2.313.0.tar.gz
export RUNNER_ALLOW_RUNASROOT=1
./config.sh --url https://github.com/${owner}/${repo} --token ${githubRegistrationToken} --labels ${label}
./run.sh
`;
}

function prepareUserData(userData: string, label: string, githubRegistrationToken: string) {
  const replace: { [key: string]: string } = {
    githubRegistrationToken,
    label,
  };
  return userData.replace(/\$\{(githubRegistrationToken|label)}/, (key) => replace[key] || key);
}

async function startEc2Instance(label: string, githubRegistrationToken: string) {
  const ud = ec2Params?.UserData;
  const userDataString = ud
    ? prepareUserData(ud, label, githubRegistrationToken)
    : buildUserDataScript(label, githubRegistrationToken);
  const userData = Buffer.from(userDataString).toString(`base64`);
  const params: RunInstancesCommandInput = ec2Params
    ? { ...ec2Params, UserData: userData }
    : {
        ImageId: ec2ImageId,
        InstanceType: ec2InstanceType,
        MinCount: 1,
        MaxCount: 1,
        UserData: userData,
        SubnetId: subnetId,
        SecurityGroupIds: [securityGroupId],
        IamInstanceProfile: { Name: iamRoleName },
        TagSpecifications: tagSpecifications,
        ...(keyName ? { KeyName: keyName } : {}),
        ...(storagePath && storageSize
          ? {
              BlockDeviceMappings: [
                {
                  DeviceName: storagePath,
                  Ebs: {
                    DeleteOnTermination: true,
                    VolumeSize: +storageSize,
                  },
                },
              ],
            }
          : {}),
      };

  try {
    const result = await new EC2().runInstances(params);
    const ec2InstanceId = result.Instances?.[0]?.InstanceId;
    if (ec2InstanceId) {
      core.info(`AWS EC2 instance ${ec2InstanceId} is started`);
      return ec2InstanceId;
    }
  } catch (error) {
    core.error(`AWS EC2 instance starting error`);
    throw error;
  }
  core.error(`AWS EC2 instance starting error`);
  throw new Error(`No ec2 instance id returned`);
}

async function terminateEc2Instance() {
  try {
    await new EC2().terminateInstances({
      InstanceIds: [ec2InstanceId],
    });
    core.info(`AWS EC2 instance ${ec2InstanceId} is terminated`);
  } catch (error) {
    core.error(`AWS EC2 instance ${ec2InstanceId} termination error`);
    throw error;
  }
}

async function waitForInstanceRunning(ec2InstanceId: string) {
  try {
    const timeoutMinutes = 5;
    await waitUntilInstanceRunning(
      {
        client: new EC2(),
        maxWaitTime: timeoutMinutes * 60,
      },
      {
        InstanceIds: [ec2InstanceId],
      },
    );
    core.info(`AWS EC2 instance ${ec2InstanceId} is up and running`);
  } catch (error) {
    core.error(`AWS EC2 instance ${ec2InstanceId} initialization error`);
    throw error;
  }
}

// use the unique label to find the runner
// as we don`t have the runner`s id, it`s not possible to get it in any other way
async function getRunner(label: string) {
  try {
    const runners = await octokit.paginate(
      `GET /repos/{owner}/{repo}/actions/runners`,
      githubContext,
    );
    const foundRunners = filter(runners, { labels: [{ name: label }] });
    return foundRunners.length > 0 ? foundRunners[0] : null;
  } catch (error) {
    return null;
  }
}

// get GitHub Registration Token for registering a self-hosted runner
async function getRegistrationToken() {
  try {
    const response = await octokit.request(
      `POST /repos/{owner}/{repo}/actions/runners/registration-token`,
      githubContext,
    );
    core.info(`GitHub Registration Token is received`);
    return response.data.token;
  } catch (error) {
    core.error(`GitHub Registration Token receiving error`);
    throw error;
  }
}

async function removeRunner() {
  const runner = await getRunner(label);

  // skip the runner removal process if the runner is not found
  if (!runner) {
    core.info(
      `GitHub self-hosted runner with label ${label} is not found, so the removal is skipped`,
    );
    return;
  }

  try {
    await octokit.request(`DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}`, {
      ...githubContext,
      runner_id: runner.id,
    });
    core.info(`GitHub self-hosted runner ${runner.name} is removed`);
  } catch (error) {
    core.error(`GitHub self-hosted runner removal error`);
    throw error;
  }
}

async function waitForRunnerRegistered(label: string) {
  const timeoutMinutes = 5;
  const retryIntervalSeconds = 10;
  const quietPeriodSeconds = 30;
  let waitSeconds = 0;

  core.info(
    `Waiting ${quietPeriodSeconds}s for the AWS EC2 instance to be registered in GitHub as a new self-hosted runner`,
  );
  await new Promise((r) => setTimeout(r, quietPeriodSeconds * 1000));
  core.info(
    `Checking every ${retryIntervalSeconds}s if the GitHub self-hosted runner is registered`,
  );

  return new Promise<void>((resolve, reject) => {
    const interval = setInterval(async () => {
      const runner = await getRunner(label);
      if (runner && runner.status === `online`) {
        core.info(`GitHub self-hosted runner ${runner.name} is registered and ready to use`);
        clearInterval(interval);
        resolve();
      } else if (waitSeconds > timeoutMinutes * 60) {
        core.error(`GitHub self-hosted runner registration error`);
        clearInterval(interval);
        reject(
          `A timeout of ${timeoutMinutes} minutes is exceeded. Your AWS EC2 instance was not able to register itself in GitHub as a new self-hosted runner.`,
        );
      } else {
        waitSeconds += retryIntervalSeconds;
        core.info(`Checking...`);
      }
    }, retryIntervalSeconds * 1000);
  });
}

function setOutput(label: string, ec2InstanceId: string) {
  core.setOutput(`label`, label);
  core.setOutput(`ec2-instance-id`, ec2InstanceId);
}

function generateUniqueLabel() {
  return Math.random().toString(36).substring(2, 7);
}

async function start() {
  const label = generateUniqueLabel();
  const githubRegistrationToken = await getRegistrationToken();
  const ec2InstanceId = await startEc2Instance(label, githubRegistrationToken);
  setOutput(label, ec2InstanceId);
  await waitForInstanceRunning(ec2InstanceId);
  await waitForRunnerRegistered(label);
}

async function stop() {
  await terminateEc2Instance();
  await removeRunner();
}

(async function () {
  try {
    mode === `start` ? await start() : await stop();
  } catch (error) {
    const e = error as Error;
    core.error(e);
    core.setFailed(e.message);
  }
})();
