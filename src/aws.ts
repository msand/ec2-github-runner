import * as AWS from 'aws-sdk';
import * as core from '@actions/core';
import * as config from './config';

const {
  githubContext: { owner, repo },
  input: {
    runnerHomeDir,
    preRunnerScript,
    ec2ImageId,
    ec2InstanceId,
    ec2InstanceType,
    ec2Params,
    iamRoleName,
    securityGroupId,
    subnetId,
    keyName,
    storagePath,
    storageSize,
  },
  tagSpecifications,
} = config;

// User data scripts are run as the root user
function buildUserDataScript(githubRegistrationToken: string, label: string) {
  if (runnerHomeDir) {
    // If runner home directory is specified, we expect the actions-runner software (and dependencies)
    // to be pre-installed in the AMI, so we simply cd into that directory and then start the runner
    return [
      '#!/bin/bash',
      `cd "${runnerHomeDir}"`,
      `echo "${preRunnerScript}" > pre-runner-script.sh`,
      'source pre-runner-script.sh',
      'export RUNNER_ALLOW_RUNASROOT=1',
      `./config.sh --url https://github.com/${owner}/${repo} --token ${githubRegistrationToken} --labels ${label}`,
      './run.sh',
    ];
  } else {
    return [
      '#!/bin/bash',
      'mkdir actions-runner && cd actions-runner',
      `echo "${preRunnerScript}" > pre-runner-script.sh`,
      'source pre-runner-script.sh',
      'case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=${ARCH}',
      'curl -O -L https://github.com/actions/runner/releases/download/v2.313.0/actions-runner-linux-${RUNNER_ARCH}-2.313.0.tar.gz',
      'tar xzf ./actions-runner-linux-${RUNNER_ARCH}-2.313.0.tar.gz',
      'export RUNNER_ALLOW_RUNASROOT=1',
      `./config.sh --url https://github.com/${owner}/${repo} --token ${githubRegistrationToken} --labels ${label}`,
      './run.sh',
    ];
  }
}

export async function startEc2Instance(label: string, githubRegistrationToken: string) {
  const userData = buildUserDataScript(githubRegistrationToken, label);
  const userDatab64 = Buffer.from(userData.join('\n')).toString('base64');
  const params = ec2Params
    ? { UserData: userDatab64, ...ec2Params }
    : {
        ImageId: ec2ImageId,
        InstanceType: ec2InstanceType,
        MinCount: 1,
        MaxCount: 1,
        UserData: userDatab64,
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
                    VolumeSize: storageSize,
                  },
                },
              ],
            }
          : {}),
      };

  try {
    const result = await new AWS.EC2().runInstances(params).promise();
    const ec2InstanceId = result.Instances?.[0]?.InstanceId;
    if (ec2InstanceId) {
      core.info(`AWS EC2 instance ${ec2InstanceId} is started`);
      return ec2InstanceId;
    }
  } catch (error) {
    core.error('AWS EC2 instance starting error');
    throw error;
  }
  core.error('AWS EC2 instance starting error');
  throw new Error('No ec2 instance id returned');
}

export async function terminateEc2Instance() {
  try {
    await new AWS.EC2()
      .terminateInstances({
        InstanceIds: [ec2InstanceId],
      })
      .promise();
    core.info(`AWS EC2 instance ${ec2InstanceId} is terminated`);
  } catch (error) {
    core.error(`AWS EC2 instance ${ec2InstanceId} termination error`);
    throw error;
  }
}

export async function waitForInstanceRunning(ec2InstanceId: string) {
  try {
    await new AWS.EC2()
      .waitFor('instanceRunning', {
        InstanceIds: [ec2InstanceId],
      })
      .promise();
    core.info(`AWS EC2 instance ${ec2InstanceId} is up and running`);
  } catch (error) {
    core.error(`AWS EC2 instance ${ec2InstanceId} initialization error`);
    throw error;
  }
}
