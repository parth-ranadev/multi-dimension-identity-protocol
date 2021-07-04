const bitcoin = require('bitcoinjs-lib');
const Ajv = require('ajv');
const request = require('request');
const {
  BTC_DUST,
  ETH_DID_CREATE,
  DID_DOC_URL_REGEX,
  BTC_BLOCKCHAIN,
  ETH_BLOCKCHAIN,
  OMNI_BLOCKCHAIN,
  TESTNET,
  PRIVATE_DB_MONGO,
  DID_DOC_SCHEMA,
} = require('../utils/constants');

const preparer = exports;

// this is an issue with the module. TODO: find a linter workaround.
// eslint-disable-next-line new-cap
const ajv = new Ajv.default({ allErrors: true });

const didDocValidator = ajv.compile(DID_DOC_SCHEMA);

preparer.get = ({ url }) => {
  const req = {
    url,
    method: 'GET',
    json: true,
  };
  return new Promise((resolve, reject) => {
    request(req, (err, httpResponse, resp) => {
      if (err) {
        reject(err);
        return;
      }
      if (resp) {
        resolve(resp);
      } else {
        reject(resp);
      }
    });
  });
};

/**
 * Function to make HTTP calls.
 * @param {Object}
 * @returns {Object}
 */
preparer.call = ({ url, method, params }) => {
  const req = {
    url,
    method,
    body: params,
    json: true,
  };
  return new Promise((resolve, reject) => {
    request(req, (err, httpResponse, resp) => {
      if (err) {
        reject(err);
        return;
      }
      if (resp && resp.result) {
        resolve(resp);
      } else {
        reject(JSON.stringify(resp));
      }
    });
  });
};

/**
 * Method to create a raw transaction for DID creation.
 * @param {string} mdipUrl
 * @param {Object} didInputs
 * @param {Object} utxoData
 * @returns {string} rawTx The unsigned raw transaction.
 */
preparer._prepareTransaction = async (mdipUrl, didInputs, utxoData) => {
  try {
    const {
      blockchain,
      network,
      didCreator: creator,
      didUpdater: updater,
      nulldata,
      bypassDocChecks,
    } = didInputs;
    if (blockchain === BTC_BLOCKCHAIN) {
      const { unspents, fee, nulldataFee } = utxoData;
      let totalAmount = 0;
      let finalFee = fee;
      const sendAmt = BTC_DUST;
      const nw = network === TESTNET
        ? bitcoin.networks.testnet
        : bitcoin.networks.bitcoin;
      if (nulldata) {
        finalFee = nulldataFee;
      }
      const psbt = new bitcoin.Psbt({ network: nw });
      for (let i = 0; i < unspents.length; i++) {
        const {
          txid, vout, amount, rawTx: { hex },
        } = unspents[i];
        totalAmount += amount;
        psbt.addInput({
          hash: txid,
          index: vout,
          nonWitnessUtxo: Buffer.from(hex, 'hex'),
        });
      }
      psbt.addOutput({
        address: updater,
        value: parseInt(sendAmt * 10 ** 8, 10),
      });
      const change = parseInt(
        (totalAmount - (sendAmt + Number(finalFee))) * 10 ** 8,
        10,
      );
      if (change > 0) {
        psbt.addOutput({
          address: creator,
          value: change,
        });
      }
      if (nulldata) {
        const data = Buffer.from(nulldata).toString('hex');
        if (data.length > 160) {
          throw new Error('DID Doc URL can have at most 160 characters');
        }
        if (!bypassDocChecks) {
          const re = new RegExp(DID_DOC_URL_REGEX, 'i');
          const isValid = re.test(nulldata);
          if (!isValid) {
            throw new Error('Invalid DID Doc URL.');
          }
          const resp = await preparer.get({ url: nulldata });
          let didDocJSON = resp;
          if (typeof resp === 'string') {
            try {
              didDocJSON = JSON.parse(resp);
            } catch (error) {
              throw new Error(error.message);
            }
          }
          const isDocValid = didDocValidator(didDocJSON);
          if (!isDocValid) {
            throw new Error('Invalid DID Doc. Schema validation failed.');
          }
        }
        const embed = bitcoin.payments.embed({ data: [Buffer.from(nulldata, 'utf8')] });
        psbt.addOutput({
          script: embed.output,
          value: 0,
        });
      }
      return psbt.toHex();
    }
    if (blockchain === ETH_BLOCKCHAIN) {
      const didDoc = 'QmTgYsbD13fL2upHXZRwrDUbXUEArVDJe81RmdqgKeCedW';
      const type = ETH_DID_CREATE;
      const rawTx = await preparer.call({
        url: `${mdipUrl}/prepareTransaction`,
        method: 'POST',
        params: {
          blockchain, type, didDoc, publicKey: creator,
        },
      });
      return rawTx;
    }
    if (blockchain === OMNI_BLOCKCHAIN) {
      const { unspents, fee, nulldataFee } = utxoData;
      let totalAmount = 0;
      let finalFee = fee;
      const sendAmt = BTC_DUST;
      const nw = network === TESTNET
        ? bitcoin.networks.testnet
        : bitcoin.networks.bitcoin;
      if (nulldata) {
        finalFee = nulldataFee;
      }
      const psbt = new bitcoin.Psbt({ network: nw });
      for (let i = 0; i < unspents.length; i++) {
        const {
          txid, vout, amount, rawTx: { hex },
        } = unspents[i];
        totalAmount += amount;
        psbt.addInput({
          hash: txid,
          index: vout,
          nonWitnessUtxo: Buffer.from(hex, 'hex'),
        });
      }
      psbt.addOutput({
        address: updater,
        value: parseInt(sendAmt * 10 ** 8, 10),
      });
      if (nulldata) {
        const data = Buffer.from(nulldata).toString('hex');
        if (data.length > 144) {
          throw new Error('DID Doc URL can have at most 144 characters');
        }
        if (!bypassDocChecks) {
          const re = new RegExp(DID_DOC_URL_REGEX, 'i');
          const isValid = re.test(nulldata);
          if (!isValid) {
            throw new Error('Invalid DID Doc URL.');
          }
          const resp = await preparer.get({ url: nulldata });
          let didDocJSON = resp;
          if (typeof resp === 'string') {
            try {
              didDocJSON = JSON.parse(resp);
            } catch (error) {
              throw new Error(error.message);
            }
          }
          const isDocValid = didDocValidator(didDocJSON);
          if (!isDocValid) {
            throw new Error('Invalid DID Doc. Schema validation failed.');
          }
        }
        const omniSendAnydata = [
          '6f6d6e69', // omni
          '0000', // version
          '00',
          'c8',
          `${data}`, // null data 72 bytes max
        ].join('');
        const embed = bitcoin.payments.embed({ data: [Buffer.from(omniSendAnydata, 'hex')] });
        psbt.addOutput({
          script: embed.output,
          value: 0,
        });
      }
      const change = parseInt(
        (totalAmount - (sendAmt + Number(finalFee))) * 10 ** 8,
        10,
      );
      if (change > 0) {
        psbt.addOutput({
          address: creator,
          value: change,
        });
      }
      return psbt.toHex();
    }
    if (blockchain === PRIVATE_DB_MONGO) {
      const ID = await preparer.call({
        url: `${mdipUrl}/prepareTransaction`,
        method: 'POST',
        params: {
          blockchain, creator, updater,
        },
      });
      return ID;
    }
    return null;
  } catch (error) {
    throw new Error(error);
  }
};
