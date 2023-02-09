const { web3 } = require('hardhat');
const { ether, expectRevert } = require('@openzeppelin/test-helpers');
const { assert } = require('chai');
const { accounts } = require('../utils');

const { members: [member1, member2, member3], internalContracts: [internal] } = accounts;
const { toBN } = web3.utils;

const days = n => 3600 * 24 * n;

describe('lockClaimAssessmentTokens', function () {

  it('reverts if locking past 180 days from current block time', async function () {

    const { token, tokenController } = this;

    const initalLockTime = toBN(days(181));

    await tokenController.mint(member1, ether('100'), { from: internal });
    await token.approve(tokenController.address, ether('100'), { from: member1 });
    await expectRevert(
      tokenController.lockClaimAssessmentTokens(ether('100'), initalLockTime, { from: member1 }),
      'TokenController: Tokens can be locked for 180 days maximum',
    );
  });

  it('locks tokens for 180 days or less', async function () {

    const { token, tokenController } = this;
    const calls = [[member1, 180], [member2, 30], [member3, 0]];

    for (const call of calls) {
      const [member, duration] = call;
      await tokenController.mint(member, ether('100'), { from: internal });
      await token.approve(tokenController.address, ether('100'), { from: member });
      await tokenController.lockClaimAssessmentTokens(ether('50'), toBN(days(duration)), { from: member });
    }
  });

});
