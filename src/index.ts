import * as core from '@actions/core';
import * as github from '@actions/github';
import type {
  _InstanceType,
  RunInstancesCommandInput,
  TagSpecification,
} from '@aws-sdk/client-ec2';
import * as AWS from '@aws-sdk/client-ec2';
import { WaiterState } from '@smithy/util-waiter/dist-types/waiter';

const { error, getInput, info, setFailed, setOutput } = core;
const { context, getOctokit } = github;
const { EC2, waitUntilInstanceRunning } = AWS;

function err(message: string): never {
  const e = new Error(message);
  setFailed(message);
  error(e);
  throw e;
}

//
// validate input
//

const mode = getInput(`mode`);
if (!mode) {
  err(`The mode input is not specified`);
}

const githubToken = getInput(`github-token`);
if (!githubToken) {
  err(`The github-token input is not specified`);
}

const ec2Params: RunInstancesCommandInput | null = JSON.parse(getInput(`ec2-params`));
const ec2ImageId = getInput(`ec2-image-id`);
const ec2InstanceType = getInput(`ec2-instance-type`) as _InstanceType;
const securityGroupId = getInput(`security-group-id`);
const subnetId = getInput(`subnet-id`);

const label = getInput(`label`);
const ec2InstanceId = getInput(`ec2-instance-id`);

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

const keyName = getInput(`key-name`);
const storagePath = getInput(`storage-path`);
const storageSize = getInput(`storage-size`);
const iamRoleName = getInput(`iam-role-name`);
const runnerHomeDir = getInput(`runner-home-dir`);
const preRunnerScript = getInput(`pre-runner-script`);

const tags = JSON.parse(getInput(`aws-resource-tags`));
const tagSpec: TagSpecification[] | undefined =
  tags.length === 0
    ? undefined
    : [
        {
          ResourceType: `instance`,
          Tags: tags,
        },
        { ResourceType: `volume`, Tags: tags },
      ];

const ec2 = new EC2();
const octokit = getOctokit(githubToken);

// the values of github.context.repo.owner and github.context.repo.repo are taken from
// the environment variable GITHUB_REPOSITORY specified in "owner/repo" format and
// provided by the GitHub Action on the runtime
const { owner, repo } = context.repo;
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
curl -O -L https://github.com/actions/runner/releases/download/v2.318.0/actions-runner-linux-\${RUNNER_ARCH}-2.318.0.tar.gz
tar xzf ./actions-runner-linux-\${RUNNER_ARCH}-2.318.0.tar.gz
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
        ...(tagSpec ? { TagSpecifications: tagSpec } : {}),
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
    const result = await ec2.runInstances(params);
    const ec2InstanceId = result.Instances?.[0]?.InstanceId;
    if (ec2InstanceId) {
      info(`AWS EC2 instance ${ec2InstanceId} is started`);
      return ec2InstanceId;
    }
  } catch (e) {
    error(`AWS EC2 instance starting error`);
    throw e;
  }
  error(`AWS EC2 instance starting error`);
  throw new Error(`No ec2 instance id returned`);
}

async function terminateEc2Instance() {
  try {
    const result = await ec2.terminateInstances({
      InstanceIds: [ec2InstanceId],
    });
    const lowByte = +(result.TerminatingInstances?.[0]?.CurrentState ?? 0) & 255;
    const description =
      lowByte === 32
        ? `shutting-down`
        : lowByte === 48
          ? 'terminated'
          : lowByte === 64
            ? 'stopping'
            : lowByte === 80
              ? 'stopped'
              : lowByte;
    if (typeof description === 'string') {
      info(`AWS EC2 instance ${ec2InstanceId} is ${description}`);
      return;
    }
    err(`Failed to terminate, EC2 instance has state: ${lowByte}
    /**
     *          <p>The valid values for instance-state-code will all be in the range of the low byte and
     *             they are:</p>
     *          <ul>
     *             <li>
     *                <p>
     *                   <code>0</code> : <code>pending</code>
     *                </p>
     *             </li>
     *             <li>
     *                <p>
     *                   <code>16</code> : <code>running</code>
     *                </p>
     *             </li>
     *             <li>
     *                <p>
     *                   <code>32</code> : <code>shutting-down</code>
     *                </p>
     *             </li>
     *             <li>
     *                <p>
     *                   <code>48</code> : <code>terminated</code>
     *                </p>
     *             </li>
     *             <li>
     *                <p>
     *                   <code>64</code> : <code>stopping</code>
     *                </p>
     *             </li>
     *             <li>
     *                <p>
     *                   <code>80</code> : <code>stopped</code>
     *                </p>
     *             </li>
     *          </ul>
     */`);
  } catch (e) {
    error(`AWS EC2 instance ${ec2InstanceId} termination error`);
    throw e;
  }
}

async function waitForInstanceRunning(ec2InstanceId: string) {
  try {
    const timeoutMinutes = 5;
    const result = await waitUntilInstanceRunning(
      {
        client: ec2,
        maxWaitTime: timeoutMinutes * 60,
      },
      {
        InstanceIds: [ec2InstanceId],
      },
    );
    const { state } = result;
    if (state === WaiterState.SUCCESS) {
      info(`AWS EC2 instance ${ec2InstanceId} is up and running`);
      return;
    }
    err(`AWS EC2 instance ${ec2InstanceId} initialization error state: ${state}`);
  } catch (e) {
    error(`AWS EC2 instance ${ec2InstanceId} initialization error`);
    throw e;
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
    return runners.find((runner) => runner.labels.some((l) => l.name === label));
  } catch (e) {
    error(`Get runner error: ${e && typeof e === 'object' && 'message' in e ? e.message : e}`);
    return undefined;
  }
}

// get GitHub Registration Token for registering a self-hosted runner
async function getRegistrationToken() {
  try {
    const response = await octokit.request(
      `POST /repos/{owner}/{repo}/actions/runners/registration-token`,
      githubContext,
    );
    info(`GitHub Registration Token is received`);
    return response.data.token;
  } catch (e) {
    error(`GitHub Registration Token receiving error`);
    throw e;
  }
}

async function removeRunner() {
  const runner = await getRunner(label);

  // skip the runner removal process if the runner is not found
  if (!runner) {
    info(`GitHub self-hosted runner with label ${label} is not found, so the removal is skipped`);
    return;
  }

  try {
    const result = await octokit.request(
      `DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}`,
      {
        ...githubContext,
        runner_id: runner.id,
      },
    );
    const { status } = result;
    if (status === 204) {
      info(`GitHub self-hosted runner ${runner.name} is removed`);
      return;
    }
    err(`Failed to remove runner ${runner.name}, status: ${status}`);
  } catch (e) {
    error(`GitHub self-hosted runner removal error`);
    throw e;
  }
}

async function waitForRunnerRegistered(label: string) {
  const timeoutMinutes = 5;
  const retryIntervalSeconds = 5;
  const quietPeriodSeconds = 15;
  const timeout = timeoutMinutes * 60;
  let attempts = Math.ceil(timeout / retryIntervalSeconds);

  info(
    `Waiting ${quietPeriodSeconds}s for the AWS EC2 instance to be registered in GitHub as a new self-hosted runner`,
  );

  await new Promise((r) => setTimeout(r, quietPeriodSeconds * 1000));

  info(`Checking every ${retryIntervalSeconds}s if the GitHub self-hosted runner is registered`);

  return new Promise<void>((resolve, reject) => {
    const interval = setInterval(async () => {
      info(`Checking...`);
      const runner = await getRunner(label);
      if (runner?.status === `online`) {
        info(`GitHub self-hosted runner ${runner.name} is registered and ready to use`);
        clearInterval(interval);
        resolve();
      } else if (attempts-- < 0) {
        error(`GitHub self-hosted runner registration error`);
        clearInterval(interval);
        reject(
          `A timeout of ${timeoutMinutes} minutes is exceeded. Your AWS EC2 instance was not able to register itself in GitHub as a new self-hosted runner.`,
        );
      }
    }, retryIntervalSeconds * 1000);
  });
}

function generateUniqueLabel() {
  return Math.random().toString(36).substring(2, 7);
}

async function start() {
  const label = generateUniqueLabel();
  const githubRegistrationToken = await getRegistrationToken();
  const ec2InstanceId = await startEc2Instance(label, githubRegistrationToken);
  setOutput(`label`, label);
  setOutput(`ec2-instance-id`, ec2InstanceId);
  await waitForInstanceRunning(ec2InstanceId);
  await waitForRunnerRegistered(label);
}

async function stop() {
  await terminateEc2Instance();
  await removeRunner();
}

(mode === `start` ? start : stop)().catch((e) => {
  error(e);
  setFailed(e && 'message' in e ? e.message : e);
});
