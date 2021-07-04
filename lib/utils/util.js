const request = require('request');
const propertiesReader = require('properties-reader');
const WEB3 = require('web3');
const path = require('path');
const mongoose = require('mongoose');
const i18n = require('../../i18n');
const {
  POST_METHOD,
  RPC_ID,
  RPC_VERSION,
  CONTENT_TYPE,
  WEIGHTED_INPUT,
  WEIGHTED_OUTPUT,
} = require('./constants');

const props = propertiesReader(path.join(`${__dirname}/../../bin/etc/local.conf`));

const web3 = new WEB3(new WEB3.providers.HttpProvider(props.get('mdip.ethHTTPProvider')));

const Util = exports;

/**
 * Function to check whether a given string is JSON or not.
 * @param {string} data
 * @returns {boolean}
 */
const isJSON = (data) => {
  try {
    JSON.parse(data);
    return true;
  } catch (error) {
    return false;
  }
};

const btcUrl = props.get('btc.url');
const btcUser = props.get('btc.username');
const btcPass = props.get('btc.password');

const omniUrl = props.get('omni.url');
const omniUser = props.get('omni.username');
const omniPass = props.get('omni.password');

/**
 * Utility method to interact with the bitcoin node.
 * @param {string} method
 * @param {array} params
 * @returns {object}
 */
const btcClient = (method, params, isOmni) => {
  let URL = btcUrl;
  let username = btcUser;
  let password = btcPass;

  if (isOmni) {
    URL = omniUrl;
    username = omniUser;
    password = omniPass;
  }

  if (!URL || !username || !password) {
    throw new Error(`No config provided to connect to the ${isOmni ? 'Omni Layer BTC' : 'BTC'} node.`);
  }
  const auth = Buffer.from(`${username}:${password}`).toString('base64');

  const req = {
    url: URL,
    method: POST_METHOD,
    body: JSON.stringify({
      jsonrpc: RPC_VERSION,
      id: RPC_ID,
      method,
      params,
    }),
    headers: { 'Content-Type': CONTENT_TYPE, Authorization: `Basic ${auth}` },
  };
  return new Promise((resolve, reject) => {
    request(req, (err, _, result) => {
      if (err) {
        reject(err);
        return;
      }
      if (isJSON(result)) {
        const parsedRes = JSON.parse(result);
        if (parsedRes && parsedRes.result) {
          resolve(parsedRes);
        } else {
          reject(parsedRes);
        }
      } else {
        reject(err);
      }
    });
  });
};

/**
 * Utility method to calculate fee for a specific transaction.
 * @param {number} inputs
 * @param {number} outputs
 * @returns {number}
 */
const calculateFee = async (inputs, outputs, isOmni) => {
  try {
    const { feerate } = (await btcClient('estimatesmartfee', [6], isOmni)).result;
    if (feerate) {
      const txSize = inputs * WEIGHTED_INPUT + outputs * WEIGHTED_OUTPUT + inputs;
      const nulldataTxSize = txSize + 80;
      return {
        fee: (feerate * 1e5 * txSize) / 10 ** 8,
        nulldataFee: (feerate * 1e5 * nulldataTxSize) / 10 ** 8,
      };
      // 10 ** 8 is same as Math.pow(10, 8)
    }
    throw new Error('feerate not found.');
  } catch (error) {
    throw new Error(error.message);
  }
};

/**
 * Util to calculate ETH fees.
 * @param {string} fromAddr
 * @param {string} toAddr
 * @param {string} value
 * @returns {Object}
 */
const calculateFeeETH = async (fromAddr, toAddr, value) => {
  let gas = 21000;
  const gasPrice = await web3.eth.getGasPrice();
  if (toAddr) {
    gas = await web3.eth.estimateGas({
      from: fromAddr,
      to: toAddr,
      value,
    });
  }
  const fee = ((gas * Number(gasPrice)) / 10 ** 18).toFixed(18);
  return { gas: Number(gas), gasPrice: Number(gasPrice), fee: Number(fee) };
};

const prepareDoc = (_id, creator) => {
  const did = `did:mdip:mongodb-${_id}`;
  const didDoc = {
    _id,
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: `${did}`,
    publicKey: [
      {
        id: `${did}#auth`,
        controller: `${did}`,
        type: 'PrivateDbPublicKey',
        publicKey: creator,
      },
      {
        id: `${did}#vc-pubkey`,
        controller: `${did}`,
        type: 'PrivateDbPublicKey',
        publicKey: creator,
      },
    ],
    authentication: ['#auth'],
    assertionMethod: ['#vc-pubkey'],
  };
  return didDoc;
};

/**
 * Method to extract chains from a given Verifiable Credential
 * @param {Object} vc
 * @returns {Object}
 */
const extractChains = (vc) => {
  const chainInfo = {};
  const attestorDID = vc && vc.issuer && vc.issuer.id;
  const requestorDID = vc && vc.credentialSubject && vc.credentialSubject.id;
  if (attestorDID) {
    const [chain] = attestorDID.split('did:mdip:')[1].split('-');
    chainInfo.attestor = chain;
  }
  if (requestorDID) {
    const [chain] = requestorDID.split('did:mdip:')[1].split('-');
    chainInfo.requestor = chain;
  }
  return chainInfo;
};

const resHandler = (res, code, error, result, message, data) => {
  const i18nMsg = i18n({ phrase: message });
  return res.status(code).send({
    error, result, i18nMsg, data,
  });
};

const checkConnections = async () => {
  const serverInfo = {
    btc: null, eth: null, omni: null, mongodb: null,
  };
  const {
    btc, eth, omni, mongodb, mdip: { testnet },
  } = props.path();
  const isMainnet = testnet !== '1';
  if (btc) {
    const chainInfo = (await btcClient('getblockchaininfo', [])).result;
    if (isMainnet && chainInfo.chain !== 'main') {
      throw new Error('Bitcoin network mismatch');
    }
    serverInfo.btc = chainInfo;
  }
  if (eth) {
    const web3Local = new WEB3(new WEB3.providers.HttpProvider(eth.httpProvider));
    const nodeInfo = await web3Local.eth.getNodeInfo();
    const chainID = await web3Local.eth.getChainId();
    if (isMainnet && chainID !== 1) {
      throw new Error('Ethereum network mismatch');
    }
    serverInfo.eth = { nodeInfo, chainId: chainID };
  }
  if (omni) {
    const btcNodeInfo = (await btcClient('getblockchaininfo', [], true)).result;
    const omniLayerInfo = (await btcClient('omni_getinfo', [], true)).result;
    if (isMainnet && btcNodeInfo.chain !== 'main') {
      throw new Error('Omnilayer network mismatch');
    }
    serverInfo.omni = { btcNodeInfo, omniLayerInfo };
  }
  if (mongodb) {
    const connState = mongoose.connection.readyState;
    if (connState !== 1) {
      throw new Error('mongoDB connection not ready');
    }
    serverInfo.mongodb = { connState };
  }
  return serverInfo;
};

Util.btcClient = btcClient;
Util.resHandler = resHandler;
Util.checkConnections = checkConnections;

Util.helpers = {
  isJSON,
  calculateFee,
  calculateFeeETH,
  prepareDoc,
  extractChains,
};
