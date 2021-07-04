const Tx = require('ethereumjs-tx').Transaction;
const propertiesReader = require('properties-reader');
const Web3 = require('web3');
const path = require('path');

const { uptime } = require('../node/node');
const { btcClient, helpers, checkConnections } = require('../utils/util');
const i18n = require('../../i18n');
const env = require('../config/eth.env.json');
const {
  OMNI_BLOCKCHAIN,
  BTC_BLOCKCHAIN,
  ETH_BLOCKCHAIN,
} = require('../utils/constants');

const props = propertiesReader(path.join(`${__dirname}/../../bin/etc/local.conf`));
const web3 = new Web3(new Web3.providers.HttpProvider(env.ethNodeURL));

/**
 * API to check daemon's uptime.
 * @returns {object} "uptime" in milliseconds
 */
exports.getuptime = (req, res) => {
  res.status(200).send({ uptime: new Date().getTime() - uptime() });
};

exports.getServerInfo = async (req, res) => {
  // TODO: it will have its own info.
  try {
    const serverInfo = await checkConnections();
    return res.status(500).send({ error: null, result: serverInfo });
  } catch (error) {
    if (error && error.message) {
      return res.status(500).send({ error: error.message, result: null, errorObj: error });
    }
    if (error && error.error && error.error.message) {
      return res.status(500).send({
        error: error.error.message,
        result: null,
        errorObj: error.error,
      });
    }
    return res.status(500).send({ error: 'Internal error', result: null });
  }
};

/**
 * API to obtain utxos of a given address using scantxoutset.
 * @returns {object}
 */
exports.getutxos = async (req, res) => {
  try {
    const { address, blockchain } = req.body;
    if (!address) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }
    const isOmni = blockchain === OMNI_BLOCKCHAIN;
    const { success, unspents, total_amount: totalAmount } = (
      await btcClient('scantxoutset', ['start', [{ desc: `addr(${address})` }]], isOmni)
    ).result;
    const { fee, nulldataFee } = await helpers.calculateFee(unspents.length, 3, isOmni);
    const sanitizedFee = fee.toFixed(8);
    const sanitizedNulldataFee = nulldataFee.toFixed(8);
    if (success && totalAmount >= Number(sanitizedFee)) {
      for (let i = 0; i < unspents.length; i++) {
        const { txid } = unspents[i];
        // eslint-disable-next-line no-await-in-loop
        const getTx = (await btcClient('getrawtransaction', [txid, true], isOmni)).result;
        unspents[i].rawTx = getTx;
      }
      return res.status(200).send({
        error: null,
        message: 'Inputs obtained.',
        result: { unspents, fee: sanitizedFee, nulldataFee: sanitizedNulldataFee },
      });
    }
    return res.status(200).send({
      error: true,
      message: 'Sender does not have funds.',
      result: null,
    });
  } catch (errorT) {
    return res.status(500).send({ result: false, error: errorT.message });
  }
};

/**
 * API to obtain confirmations on a given BTC transaction.
 * @returns {object}
 */
exports.checkconfs = async (req, res) => {
  try {
    const { txids } = req.body;
    if (!txids || !txids.length) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }
    const result = [];
    const invalidTxids = [];
    for (let i = 0; i < txids.length; i++) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const tx = (await btcClient('getrawtransaction', [txids[i], true])).result;
        result.push({ txid: txids[i], confirmations: tx.confirmations });
      } catch (errGetTx) {
        invalidTxids.push(txids[i]);
      }
    }
    if (!result.length) {
      return res.status(200).send({
        error: true,
        message: `All of the given transaction ids${JSON.stringify(invalidTxids)} were invalid.`,
        result: null,
      });
    }
    return res.status(200).send({
      error: null,
      message: 'Confirmations obtained successfully.',
      result: { valid: result, invalid: invalidTxids },
    });
  } catch (errorT) {
    return res.status(500).send({ result: false, error: errorT.message });
  }
};

/** Development only service. */
/**
 * API to fund any ETH address with a specific amount.
 * @returns {object}
 */
exports.fundETHAddress = async (req, res) => {
  const { toAddr } = req.body;
  if (!toAddr) {
    return res.status(400).send({ error: 'Send proper parameters.', result: null });
  }
  const amount = props.get('mdip.ethTransferAmount');
  const chainID = props.get('mdip.chainID');
  if (!props.get('mdip.ethSenderAccount') || !props.get('mdip.ethSenderPrivateKey') || !amount || !chainID) {
    return res.status(400).send({ error: 'config not set.', result: null });
  }
  const fromAddr = `0x${props.get('mdip.ethSenderAccount')}`;
  const privateKey = `0x${props.get('mdip.ethSenderPrivateKey')}`;
  try {
    const isToAddrValid = web3.utils.isAddress(toAddr);
    if (!isToAddrValid) {
      return res.status(400).send({ error: `Invalid toAddr ${toAddr} sent`, result: null });
    }
    const ethBalance = await web3.eth.getBalance(fromAddr);
    const ethBalanceDecimal = Number(web3.utils.fromWei(ethBalance, 'ether'));
    const { gas, gasPrice } = await helpers.calculateFeeETH(fromAddr, toAddr, ethBalance);
    const fee = web3.utils.fromWei(
      String(Number(gas) * Number(gasPrice)),
      'ether',
    );
    if (ethBalanceDecimal < Number(amount) + Number(fee)) {
      return res.status(400).send({
        error: `Current ETH balance ${ethBalanceDecimal} is less than required amount + fee ${
          Number(amount) + Number(fee)
        }`,
        result: null,
      });
    }
    const proPrivateKey = Buffer.from(privateKey.substr(2), 'hex');
    const nonce = await web3.eth.getTransactionCount(fromAddr, 'pending');
    const rawTx = {
      from: fromAddr,
      to: toAddr,
      value: web3.utils.toHex(web3.utils.toWei(String(amount), 'ether')),
      gas: Number(gas),
      gasPrice: Number(gasPrice),
      nonce,
    };
    const tx = new Tx(rawTx, { chain: Number(chainID) });
    tx.sign(proPrivateKey);
    const serializedTx = tx.serialize();
    const proSerializedTx = `0x${serializedTx.toString('hex')}`;
    const sentTx = await web3.eth.sendSignedTransaction(proSerializedTx);
    return res.status(200).send({
      error: null,
      message: 'Txn sent successfully.',
      result: {
        hash: sentTx.transactionHash,
        fee,
        gas,
        gasPrice,
        amount,
      },
    });
  } catch (errT) {
    if (errT && errT.message) {
      return res.status(500).send({ error: errT.message, result: null });
    }
    return res.status(500).send({ error: 'Internal error.', result: null });
  }
};

exports.getTxDetails = async (req, res) => {
  const { txid, blockchain } = req.query;
  if (!txid) {
    return res.status(400).send({ error: 'Send proper parameters.', result: null });
  }
  try {
    const isOmni = blockchain === OMNI_BLOCKCHAIN;
    const getRawTx = (await btcClient('getrawtransaction', [txid, true], isOmni)).result;
    const getBlock = (await btcClient('getblock', [getRawTx.blockhash, 1], isOmni)).result;
    getRawTx.blockHeight = getBlock.height;
    getRawTx.txIndex = getBlock.tx.indexOf(txid);
    return res.status(200).send({
      error: null,
      message: 'Data obtained successfully.',
      result: getRawTx,
    });
  } catch (errT) {
    if (errT && errT.message) {
      return res.status(500).send({ error: errT.message, result: null });
    }
    return res.status(500).send({ error: 'Internal error.', result: null });
  }
};

exports.getFunds = async (req, res) => {
  const { address, blockchain, network } = req.query;
  if (!address || !blockchain || !network) {
    return res.status(400).send({ error: 'Send proper parameters.', result: null });
  }
  try {
    const isOmni = blockchain === OMNI_BLOCKCHAIN;
    if (blockchain === BTC_BLOCKCHAIN || isOmni) {
      let balance = 0;
      const { success, total_amount: totalAmount } = (
        await btcClient('scantxoutset', ['start', [{ desc: `addr(${address})` }]], isOmni)
      ).result;
      if (success && totalAmount) {
        balance = totalAmount;
      }
      return res.status(200).send({
        error: null,
        message: 'Balance obtained successfully.',
        result: {
          address, balance, blockchain, network,
        },
      });
    }
    if (blockchain === ETH_BLOCKCHAIN) {
      const ethBalance = await web3.eth.getBalance(address);
      const ethBalanceDecimal = Number(web3.utils.fromWei(ethBalance, 'ether'));
      return res.status(200).send({
        error: null,
        message: 'Balance obtained successfully.',
        result: {
          address, balance: ethBalanceDecimal, blockchain, network,
        },
      });
    }
    return res.status(200).send({
      error: true,
      message: 'Invalid blockchain queried.',
      result: null,
    });
  } catch (errT) {
    if (errT && errT.message) {
      return res.status(500).send({ error: errT.message, result: null });
    }
    return res.status(500).send({ error: 'Internal error.', result: null });
  }
};
