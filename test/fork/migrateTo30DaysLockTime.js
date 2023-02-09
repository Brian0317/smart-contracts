const { artifacts, accounts, web3, network } = require('hardhat');
const { ether, expectRevert, time } = require('@openzeppelin/test-helpers');
const fetch = require('node-fetch');
const { assert } = require('chai');
const BN = require('web3').utils.BN;

const { encode1 } = require('./external');
const { logEvents, hex } = require('../utils').helpers;

const MemberRoles = artifacts.require('MemberRoles');
const NXMaster = artifacts.require('NXMaster');
const NXMToken = artifacts.require('NXMToken');
const Governance = artifacts.require('Governance');
const PooledStaking = artifacts.require('PooledStaking');
const TokenFunctions = artifacts.require('TokenFunctions');
const UpgradeabilityProxy = artifacts.require('UpgradeabilityProxy');

const upgradeProxyImplementationCategoryId = 5;
const newContractAddressUpgradeCategoryId = 29;
const addNewInternalContractCategoryId = 34;

const day = 24 * 60 * 60;

function batch (a, batchSize) {
  const batches = [];
  let currentBatch = [];
  for (let i = 0; i < a.length; i++) {
    if (currentBatch.length === batchSize) {
      batches.push(currentBatch);
      currentBatch = [a[i]];
    } else {
      currentBatch.push(a[i]);
    }
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  return batches;
}

async function submitGovernanceProposal (categoryId, actionHash, members, gv, submitter) {

  const proposalTitle = 'proposal';
  const proposalSD = 'proposal';
  const proposalDescHash = 'proposal';
  const incentive = 0;
  const proposalId = await gv.getProposalLength();
  console.log(`Creating proposal ${proposalId}`);

  await gv.createProposal(proposalTitle, proposalSD, proposalDescHash, 0, { from: submitter });
  await gv.categorizeProposal(proposalId, categoryId, incentive, { from: submitter });
  await gv.submitProposalWithSolution(proposalId, 'proposal', actionHash, { from: submitter });

  console.log(`Voting for proposal ${proposalId}`);

  for (let i = 0; i < members.length; i++) {
    await gv.submitVote(proposalId, 1, { from: members[i] });
  }

  console.log(`Closing proposal`);
  await time.increase(604800);
  logEvents(await gv.closeProposal(proposalId, { from: submitter }));

  const proposal = await gv.proposal(proposalId);
  assert.equal(proposal[2].toNumber(), 3);
}

let isHardhat;
const hardhatRequest = async (...params) => {

  if (isHardhat === undefined) {
    const nodeInfo = await web3.eth.getNodeInfo();
    isHardhat = !!nodeInfo.match(/Hardhat/);
  }

  if (isHardhat) {
    return network.provider.request(...params);
  }
};

const unlock = async member => hardhatRequest({ method: 'hardhat_impersonateAccount', params: [member] });

describe('lock time migration', function () {

  this.timeout(0);

  it('performs contract upgrades', async function () {

    const versionData = await fetch('https://api.nexusmutual.io/version-data/data.json').then(r => r.json());
    const [{ address: masterAddress }] = versionData.mainnet.abis.filter(({ code }) => code === 'NXMASTER');

    const master = await NXMaster.at(masterAddress);
    const { contractsName, contractsAddress } = await master.getVersionData();

    const nameToAddressMap = {
      NXMTOKEN: await master.dAppToken(),
    };

    for (let i = 0; i < contractsName.length; i++) {
      nameToAddressMap[web3.utils.toAscii(contractsName[i])] = contractsAddress[i];
    }

    const mr = await MemberRoles.at(nameToAddressMap['MR']);
    const tk = await NXMToken.at(nameToAddressMap['NXMTOKEN']);
    const gv = await Governance.at(nameToAddressMap['GV']);
    const ps = await PooledStaking.at(nameToAddressMap['PS']);

    const owners = await mr.members('3');
    const firstBoardMember = owners.memberArray[0];

    const members = await mr.members('1');
    const boardMembers = members.memberArray;
    const secondBoardMember = boardMembers[1];

    assert.equal(boardMembers.length, 5);
    console.log('Board members:', boardMembers);

    const [funder] = accounts;

    for (const member of boardMembers) {
      console.log(`Topping up ${member}`);
      await web3.eth.sendTransaction({ from: funder, to: member, value: ether('100000') });
      await unlock(member);
    }

    const REWARD_ROUND_DURATION = await ps.REWARD_ROUND_DURATION();
    const REWARD_ROUNDS_START = await ps.REWARD_ROUNDS_START();

    console.log(`Deploying new contracts`);
    const newPS = await PooledStaking.new();
    const newPSAddress = newPS.address;

    const txData = encode1(
      ['bytes2[]', 'address[]'],
      [[hex('PS')], [newPSAddress]],
    );

    console.log(`Proposal tx data: ${txData}`);

    await submitGovernanceProposal(
      upgradeProxyImplementationCategoryId,
      txData, boardMembers, gv, firstBoardMember,
    );

    const psProxy = await UpgradeabilityProxy.at(await master.getLatestAddress(hex('PS')));
    const storedNewPSAddress = await psProxy.implementation();
    assert.equal(storedNewPSAddress, newPSAddress);

    const latestPS = await PooledStaking.at(await master.getLatestAddress(hex('PS')));

    const NEW_REWARD_ROUND_DURATION = await latestPS.REWARD_ROUND_DURATION();
    const NEW_REWARD_ROUNDS_START = await latestPS.REWARD_ROUNDS_START();

    assert.equal(NEW_REWARD_ROUND_DURATION.toString(), REWARD_ROUND_DURATION.toString());
    assert.equal(NEW_REWARD_ROUNDS_START.toString(), REWARD_ROUNDS_START.toString());
    const UNSTAKE_LOCK_TIME = await ps.UNSTAKE_LOCK_TIME();
    // this value is still 90 until migration is finished
    assert.equal(UNSTAKE_LOCK_TIME.toString(), (90 * day).toString());

    console.log(`Successfully deployed new contracts`);

    this.firstBoardMember = firstBoardMember;
    this.secondBoardMember = secondBoardMember;
    this.master = master;
    this.tk = tk;
    this.tf = await TokenFunctions.at(await master.getLatestAddress(hex('TF')));
    this.ps = latestPS;

    const psNXMBalance = await tk.balanceOf(this.ps.address);
    const nxmSupply = await tk.totalSupply();
    this.balances = {
      psNXMBalance,
      nxmSupply,
    };
  });

  async function readCurrentUnstakes ({ ps, maxBatches }) {
    const start = await ps.unstakeRequestAtIndex(0);
    const startIndex = start.next;

    const lastUnstakeRequestId = await ps.lastUnstakeRequestId();
    console.log({
      startIndex: startIndex.toString(),
      lastUnstakeRequestId: lastUnstakeRequestId.toString(),
    });
    const allUnstakeIds = [];
    for (let i = startIndex; i <= lastUnstakeRequestId.toNumber(); i++) {
      allUnstakeIds.push(i);
    }

    const batchSize = 50;
    const batches = batch(allUnstakeIds, batchSize);
    console.log({
      batcheslen: batches.length,
      batchSize,
      totalLen: allUnstakeIds.length,
    });
    const allUnstakeRequests = [];
    let i = 0;
    for (const batch of batches) {
      if (maxBatches && i >= maxBatches) {
        console.log(`Reached maxBatches=${maxBatches}`);
        break;
      }
      console.log({
        batch: i++,
      });
      const unstakesBatch = await Promise.all(batch.map(i => ps.unstakeRequestAtIndex(i)));
      allUnstakeRequests.push(...unstakesBatch);
    }

    console.log(`Found ${allUnstakeRequests.length} unstake requests`);
    return allUnstakeRequests;
  }

  async function assertUnstakes (allUnstakesBefore, unstakesAfter, now) {

    const diff = allUnstakesBefore.length - unstakesAfter.length;
    const processedUnstakes = allUnstakesBefore.slice(0, diff);
    const unstakesBefore = allUnstakesBefore.slice(diff);

    assert.equal(unstakesBefore.length, unstakesAfter.length);
    assert.equal(processedUnstakes.length, diff);

    for (let i = 0; i < processedUnstakes.length; i++) {
      const before = processedUnstakes[i];
      const expectedUnstakeAt = before.unstakeAt.toNumber() - 60 * day;
      assert(expectedUnstakeAt <= now);
    }

    for (let i = 0; i < unstakesBefore.length; i++) {

      const before = unstakesBefore[i];
      const after = unstakesAfter[i];
      assert.equal(before.amount.toString(), before.amount.toString());
      const expectedUnstakeAt = before.unstakeAt.toNumber() - 60 * day;
      // console.log({
      //   before: before.unstakeAt.toNumber(),
      //   after: after.unstakeAt.toNumber(),
      // });
      assert.equal(after.unstakeAt.toString(), expectedUnstakeAt.toString());
      assert.equal(before.contractAddress, after.contractAddress);
      assert.equal(before.stakerAddress, after.stakerAddress);
    }
  }

  async function calculateUnstakeOutcome (unstakesBefore) {
    const now = Math.floor(new Date().getTime() / 1000);
    const toBeUnstaked = [];
    for (const unstake of unstakesBefore) {
      const newUnstakeTime = unstake.unstakeAt.toNumber() - 60 * day;
      if (newUnstakeTime < now) {
        toBeUnstaked.push(unstake);
      }
    }
    let totalUnstaked = new BN('0');
    for (const futureUnstake of toBeUnstaked) {
      totalUnstaked = futureUnstake.amount.add(totalUnstaked);
    }

    return {
      totalUnstaked,
      toBeUnstaked,
    };
  }

  it('migrates pending unstakes to new lock time', async function () {

    const { ps } = this;
    const MAX_ITERATIONS = 200;

    const maxBatches = undefined;
    console.log('Reading unstakes before migration..');
    const unstakesBeforeMigration = await readCurrentUnstakes({ ps, maxBatches });

    const { totalUnstaked, toBeUnstaked } = await calculateUnstakeOutcome(unstakesBeforeMigration);
    console.log({
      totalExpectedUnstaked: totalUnstaked.toString(),
      totalExpectedUnstakedUnits: totalUnstaked.div(new BN(1e18.toString())).toString(),
      unstakeRequestsToProcess: toBeUnstaked.length,
    });

    let finished = false;
    let totalGasUsed = 0;
    let callCount = 0;

    while (!finished) {
      const tx = await ps.migratePendingUnstakesToNewLockTime(MAX_ITERATIONS, { gas: 12e6 });
      console.log('tx.receipt.gasUsed', tx.receipt.gasUsed);
      totalGasUsed += tx.receipt.gasUsed;
      const [lockTimeMigrationCompleted] = tx.logs.filter(log => log.event === 'LockTimeMigrationCompleted');
      finished = lockTimeMigrationCompleted.args.finished;
      console.log('startUnstakeIndex', lockTimeMigrationCompleted.args.startUnstakeIndex.toString());
      console.log('endUnstakeIndex', lockTimeMigrationCompleted.args.endUnstakeIndex.toString());
      console.log(`Processing migration finished: ${finished}`);
      callCount++;
    }

    const { timestamp: now } = await web3.eth.getBlock('latest');

    console.log('Reading unstakes after migration..');
    const unstakesAfterMigration = await readCurrentUnstakes({ ps, maxBatches });

    await expectRevert(
      ps.migratePendingUnstakesToNewLockTime(1),
      'PooledStaking: Migration finished',
    );

    console.log('Asserting unstakes changed correctly..');
    assertUnstakes(unstakesBeforeMigration, unstakesAfterMigration, now);

    const newLockTime = await ps.UNSTAKE_LOCK_TIME();
    assert.equal(newLockTime.toString(), (30 * day).toString());

    console.log({
      totalGasUsed,
      callCount,
    });
  });

  it('nxm balances stay the same after migration', async function () {
    const { tk, balances } = this;
    const psNXMBalance = await tk.balanceOf(this.ps.address);
    const nxmSupply = await tk.totalSupply();

    assert.equal(psNXMBalance.toString(), balances.psNXMBalance.toString());
    assert.equal(nxmSupply.toString(), balances.nxmSupply.toString());
  });

  it(`users can unstake after migration is finished and get 30 day lock time`, async function () {
    const { ps, firstBoardMember } = this;

    const firstContract = await ps.stakerContractAtIndex(firstBoardMember, 0);
    const minUnstake = await ps.MIN_UNSTAKE();
    console.log({
      message: 'Attempting unstake..',
      firstContract,
      firstBoardMember,
      minUnstake: minUnstake.toString(),
    });

    const lastUnstakeRequestId = await ps.lastUnstakeRequestId();
    console.log({
      lastUnstakeRequestId: lastUnstakeRequestId.toString(),
    });
    const tx = await ps.requestUnstake([firstContract], [minUnstake], lastUnstakeRequestId, {
      from: firstBoardMember,
    });

    const block = await web3.eth.getBlock(tx.receipt.blockNumber);
    const expectedUnstakeAt = block.timestamp + 30 * day;

    console.log('Unstake request succesful');
    const lastUnstakeRequestIdPostUnstake = await ps.lastUnstakeRequestId();
    const unstake = await ps.unstakeRequests(lastUnstakeRequestIdPostUnstake);

    assert.equal(unstake.amount.toString(), minUnstake.toString());
    assert.equal(unstake.unstakeAt.toString(), expectedUnstakeAt.toString());
    assert.equal(unstake.contractAddress, firstContract);
    assert.equal(unstake.stakerAddress, firstBoardMember);
    assert.equal(unstake.next, '0');
  });
});
