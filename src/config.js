const core = require('@actions/core');
const github = require('@actions/github');

function err(message) {
  core.error(new Error(message));
  core.setFailed(message);
}

function generateUniqueLabel() {
  return Math.random().toString(36).substring(2, 7);
}

const input = {
  mode: core.getInput('mode'),
  githubToken: core.getInput('github-token'),
  ec2Params: JSON.parse(core.getInput('ec2-params')),
  ec2ImageId: core.getInput('ec2-image-id'),
  ec2InstanceType: core.getInput('ec2-instance-type'),
  subnetId: core.getInput('subnet-id'),
  securityGroupId: core.getInput('security-group-id'),
  keyName: core.getInput('key-name'),
  storagePath: core.getInput('storage-path'),
  storageSize: core.getInput('storage-size'),
  label: core.getInput('label'),
  ec2InstanceId: core.getInput('ec2-instance-id'),
  iamRoleName: core.getInput('iam-role-name'),
  runnerHomeDir: core.getInput('runner-home-dir'),
  preRunnerScript: core.getInput('pre-runner-script'),
};

const tags = JSON.parse(core.getInput('aws-resource-tags'));
const tagSpecifications =
  tags.length === 0
    ? null
    : [
        {
          ResourceType: 'instance',
          Tags: tags,
        },
        { ResourceType: 'volume', Tags: tags },
      ];

// the values of github.context.repo.owner and github.context.repo.repo are taken from
// the environment variable GITHUB_REPOSITORY specified in "owner/repo" format and
// provided by the GitHub Action on the runtime
const { owner, repo } = github.context.repo;
const githubContext = {
  owner: owner,
  repo: repo,
};

//
// validate input
//

if (!input.mode) {
  err(`The 'mode' input is not specified`);
}

if (!input.githubToken) {
  err(`The 'github-token' input is not specified`);
}

if (input.mode === 'start') {
  if (!input.params && (!input.ec2ImageId || !input.ec2InstanceType || !input.subnetId || !input.securityGroupId)) {
    err(`Not all the required inputs are provided for the 'start' mode`);
  }
} else if (input.mode === 'stop') {
  if (!input.label || !input.ec2InstanceId) {
    err(`Not all the required inputs are provided for the 'stop' mode`);
  }
} else {
  err('Wrong mode. Allowed values: start, stop.');
}

module.exports = {
  input,
  githubContext,
  generateUniqueLabel,
  tagSpecifications,
};
