const bitcoinMessage = require('bitcoinjs-message');
const propertiesReader = require('properties-reader');
const path = require('path');

const ethDID = require('./eth.did.service');
const { btcClient, helpers } = require('../utils/util');
const { convertPubkeyToAddr } = require('../utils');
const i18n = require('../../i18n');
const { txrefToTxid } = require('../utils/tx-ref');
const ipfs = require('../ipfs');
const {
  PRIVATE_DB_MONGO,
} = require('../utils/constants');
const DIDModel = require('../models/did.model');

const props = propertiesReader(path.join(`${__dirname}/../../bin/etc/local.conf`));

let txChainLevel = 1;
let txChain = {};

/**
 * Tx Chain parsing logic
 * @param {string} txid
 * @param {string} vout
 * @param {string} blockhash
 * @returns {Object}
 */
async function parseBlocks(txid, vout, blockhash, isOmni) {
  let txidBuf = txid;
  let voutBuf = vout;
  const { tx, nTx, nextblockhash } = (
    await btcClient('getblock', [blockhash, 2])
  ).result;
  for (let x = 0; x < nTx; x++) {
    const { vin, vout: currVout, txid: currTxid } = tx[x];
    for (let y = 0; y < vin.length; y++) {
      const { txid: vinTxid, vout: vinVout } = vin[y];
      if (vinTxid === txid && vinVout === vout) {
        let OP_RETURN = null;
        for (let i = 0; i < currVout.length; i++) {
          const { asm, type } = currVout[i].scriptPubKey;
          if (type === 'nulldata') {
            [OP_RETURN] = asm.split('OP_RETURN ');
          }
        }
        if (!OP_RETURN) {
          throw new Error(
            `DID continuation doc not found at level ${txChainLevel}.`,
          );
        }
        txidBuf = currTxid;
        voutBuf = currVout[0].n;
        tx[x].ddo = OP_RETURN;
        txChain[txChainLevel] = tx[x];
        txChainLevel += 1;
      }
    }
  }
  if (!nextblockhash) {
    const res = { ...txChain };
    res.final = res[txChainLevel - 1];
    txChain = {};
    txChainLevel = 1;
    return res;
  }
  return parseBlocks(txidBuf, voutBuf, nextblockhash, isOmni);
}

/**
 * Funtion to obtain transactions that spent the utxos.
 * @param {string} txid
 * @param {string} vout
 * @returns {Object}
 */
async function getTxsChain(txid, vout, isOmni) {
  try {
    await btcClient('gettxout', [txid, vout], isOmni);
    return {};
  } catch (errTxo) {
    const getRawTx = (await btcClient('getrawtransaction', [txid, true], isOmni))
      .result;
    const { blockhash } = getRawTx;
    return parseBlocks(txid, vout, blockhash, isOmni);
  }
}
/**
 * API to update a DID.
 * @returns {object}
 */
// eslint-disable-next-line consistent-return
exports.updateDID = async (req, res) => {
  try {
    const { network } = req.body;
    if (!network) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }
    if (network === PRIVATE_DB_MONGO) {
      const { did, sign, newController: publicKey } = req.body;
      if (
        !did
        || !sign
        || !publicKey
      ) {
        return res
          .status(400)
          .send({ result: null, error: i18n('Missing parameters') });
      }
      const ID = did.split('did:mdip:mongodb-')[1];
      const didDoc = await DIDModel.findOne({ _id: ID }, {
        __v: 0, createdAt: 0, updatedAt: 0,
      });
      if (!didDoc) {
        return res.status(200).send({
          error: true,
          message: 'DID Doucment does not exists.',
          result: null,
        });
      }
      const currentCtrlPubKey = didDoc.publicKey[0].publicKey;
      const addr = convertPubkeyToAddr(network, '', currentCtrlPubKey);
      const verify = bitcoinMessage.verify(did, addr, sign);
      if (!verify) {
        return res.status(200).send({
          error: true,
          message: 'Given address does not control the DID.',
          result: null,
        });
      }
      const updateObj = {};
      didDoc.publicKey.map((el, index) => {
        updateObj[index].publicKey = publicKey;
        return true;
      });
      await DIDModel.findOneAndUpdate({ _id: didDoc._id }, { $set: updateObj });
      return res.status(200).send({
        error: null,
        message: 'DID Doc updated successfully.',
        result: true,
      });
    }
    const {
      did,
      didUpdaterKeypair: { address, privateKey },
      newReceiver,
      didDocURL,
    } = req.body;
    if (
      !did
      || !address
      || !privateKey
      || !newReceiver
      || !didDocURL
    ) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }
    const isOmni = did.includes('did:mdip:omni-');
    const splitByStr = isOmni ? 'omni-' : 'btc-';
    const txRef = did.split(':')[2].split(splitByStr)[1];
    const finalTxRef = network === 'mainnet' ? `tx1:${txRef}` : `txtest1:${txRef}`;
    const { txid, utxoIndex } = await txrefToTxid(finalTxRef, btcClient);
    let txoCall;
    try {
      txoCall = await btcClient('gettxout', [txid, utxoIndex], isOmni);
    } catch (errTxo) {
      return res.status(400).send({
        error: true,
        message: 'DID already revoked.',
      });
    }
    const txo = txoCall.result;
    if (txo && txo.scriptPubKey.addresses[0] !== address) {
      return res.status(400).send({
        error: null,
        message: 'Invalid DID updater key pair provided.',
      });
    }
    if (txo) {
      let inputs = [{ txid, vout: utxoIndex }];
      const fee = helpers.calculateFee(1, 1);
      let totalAmount = txo.value;
      if (totalAmount < fee) {
        const unspents = (
          await btcClient('listunspent', [
            1,
            9999999,
            [txo.scriptPubKey.addresses[0]],
          ], isOmni)
        ).result;
        totalAmount = unspents.reduce((acc, u) => acc + u.amount, 0);
        if (totalAmount < fee) {
          return res.status(400).send({
            error: null,
            message: 'DID does not have funds to pay for update fee.',
          });
        }
        inputs = unspents.map((x) => ({ txid: x.txid, vout: x.vout }));
      }
      const outputs = { [newReceiver]: (totalAmount - fee).toFixed(8) };
      outputs.data = Buffer.from(didDocURL).toString('hex'); // OP_RETURN
      if (isOmni) {
        /**
         * data embedded for a tx to be identified as omni layer tx.
         * contains omni chain + version data
         */
        outputs.data = `6f6d6e69000000c8${outputs.data}`;
      }
      const rawTx = await btcClient('createrawtransaction', [inputs, outputs], isOmni);
      const signedTx = await btcClient('signrawtransactionwithkey', [
        rawTx.result,
        [privateKey],
      ], isOmni);
      if (signedTx.result && signedTx.result.complete) {
        const sentTx = await btcClient('sendrawtransaction', [
          signedTx.result.hex,
        ], isOmni);
        return res.status(400).send({
          error: null,
          message: `DID: ${did} updated successfully.`,
          result: sentTx,
        });
      }
      if (signedTx.result && !signedTx.result.complete) {
        return res.status(400).send({
          error: true,
          message: 'Invalid private key provided.',
        });
      }
    }
  } catch (errorT) {
    return res.status(500).send({ result: false, error: errorT.message });
  }
};

/**
 * API to delete a DID.
 * @returns {object}
 */
// eslint-disable-next-line consistent-return
exports.deleteDID = async (req, res) => {
  try {
    const { network } = req.body;
    if (!network) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }
    if (network === PRIVATE_DB_MONGO) {
      const { did, sign } = req.body;
      if (!did || !sign) {
        return res
          .status(400)
          .send({ result: null, error: i18n('Missing parameters') });
      }
      const ID = did.split('did:mdip:mongodb-')[1];
      const didDoc = await DIDModel.findOne({ _id: ID }, {
        __v: 0, createdAt: 0, updatedAt: 0,
      });
      if (!didDoc) {
        return res.status(200).send({
          error: true,
          message: 'DID Doucment does not exists.',
          result: null,
        });
      }
      const currentCtrlPubKey = didDoc.publicKey[0].publicKey;
      const addr = convertPubkeyToAddr(network, '', currentCtrlPubKey);
      const verify = bitcoinMessage.verify(did, addr, sign);
      if (!verify) {
        return res.status(200).send({
          error: true,
          message: 'Given address does not control the DID.',
          result: null,
        });
      }
      await DIDModel.findOneAndDelete({ _id: didDoc._id });
      return res.status(200).send({
        error: null,
        message: 'DID deleted successfully.',
        result: true,
      });
    }
    const {
      did,
      didUpdaterKeypair: { address, privateKey },
      newReceiver,
    } = req.body;
    if (!did || !address || !privateKey || !newReceiver) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }
    const isOmni = did.includes('did:mdip:omni-');
    const splitByStr = isOmni ? 'omni-' : 'btc-';
    const txRef = did.split(':')[2].split(splitByStr)[1];
    const finalTxRef = network === 'mainnet' ? `tx1:${txRef}` : `txtest1:${txRef}`;
    const { txid, utxoIndex } = await txrefToTxid(finalTxRef, btcClient, isOmni);
    let txoCall;
    try {
      txoCall = await btcClient('gettxout', [txid, utxoIndex], isOmni);
    } catch (errTxo) {
      return res.status(400).send({
        error: true,
        message: 'DID already revoked.',
      });
    }
    const txo = txoCall.result;
    if (txo && txo.scriptPubKey.addresses[0] !== address) {
      return res.status(400).send({
        error: null,
        message: 'Invalid DID updater key pair provided.',
      });
    }
    if (txo) {
      let inputs = [{ txid, vout: utxoIndex }];
      const fee = helpers.calculateFee(1, 1);
      let totalAmount = txo.value;
      if (totalAmount < fee) {
        const unspents = (
          await btcClient('listunspent', [
            1,
            9999999,
            [txo.scriptPubKey.addresses[0]],
          ], isOmni)
        ).result;
        totalAmount = unspents.reduce((acc, u) => acc + u.amount, 0);
        if (totalAmount < fee) {
          return res.status(400).send({
            error: null,
            message: 'DID does not have funds to pay for revoke fee.',
          });
        }
        inputs = unspents.map((x) => ({ txid: x.txid, vout: x.vout }));
      }
      /** TODO: validate newReceiver address. */
      const outputs = { [newReceiver]: (totalAmount - fee).toFixed(8) };
      const rawTx = await btcClient('createrawtransaction', [inputs, outputs], isOmni);
      const signedTx = await btcClient('signrawtransactionwithkey', [
        rawTx.result,
        [privateKey],
      ], isOmni);
      if (signedTx.result && signedTx.result.complete) {
        const sentTx = await btcClient('sendrawtransaction', [
          signedTx.result.hex,
        ], isOmni);
        return res.status(400).send({
          error: null,
          message: `DID: ${did} revoked successfully.`,
          result: sentTx,
        });
      }
      if (signedTx.result && !signedTx.result.complete) {
        return res.status(400).send({
          error: true,
          message: 'Invalid private key provided.',
        });
      }
    }
  } catch (errorT) {
    return res.status(500).send({ result: false, error: errorT.message });
  }
};

/**
 * API to read a DID.
 * @returns {object}
 */
exports.readDID = async (req, res) => {
  try {
    const { did } = req.query;
    if (!did) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }
    const [chain] = did.split('did:mdip:')[1].split('-');
    if (chain === 'eth') {
      const didTx = await ethDID.getDID(did);
      const didDoc = await ipfs.download(didTx.data.metadata);
      return res.status(200).send({
        error: null,
        message: 'DID Doucment obtained successfully.',
        result: didDoc,
      });
    }
    if (chain === PRIVATE_DB_MONGO) {
      const ID = did.split('did:mdip:mongodb-')[1];
      const didDoc = await DIDModel.findOne({ _id: ID }, {
        _id: 0, __v: 0, createdAt: 0, updatedAt: 0,
      });
      if (didDoc) {
        return res.status(200).send({
          error: null,
          message: 'DID Doucment obtained successfully.',
          result: didDoc,
        });
      }
      return res.status(200).send({
        error: true,
        message: 'DID Doucment does not exists.',
        result: null,
      });
    }
    const isOmni = did.includes('did:mdip:omni-');
    const splitByStr = isOmni ? 'omni-' : 'btc-';
    const network = props.get('mdip.testnet') === 1 ? 'testnet' : 'mainnet';
    const txRef = did.split(':')[2].split(splitByStr)[1];
    const finalTxRef = network === 'mainnet' ? `tx1:${txRef}` : `txtest1:${txRef}`;
    const { txid, utxoIndex } = await txrefToTxid(finalTxRef, btcClient, isOmni);
    const resp = await getTxsChain(txid, utxoIndex, isOmni);
    if (Object.keys(resp).length) {
      const {
        final: { ddo },
      } = resp;
      const didDocURL = Buffer.from(ddo, 'hex').toString();
      return res.status(200).send({
        error: null,
        result: didDocURL,
        message: 'DID Document obtained successfully.',
      });
    }
    const { vin, vout } = (
      await btcClient('getrawtransaction', [txid, true], isOmni)
    ).result;
    let OP_RETURN = null;
    for (let i = 0; i < vout.length; i++) {
      const { asm, type } = vout[i].scriptPubKey;
      if (type === 'nulldata') {
        [OP_RETURN] = asm.split('OP_RETURN ');
      }
    }
    if (OP_RETURN) {
      if (isOmni) {
        OP_RETURN = OP_RETURN.substr(16);
      }
      const document = Buffer.from(OP_RETURN, 'hex').toString();
      return res.status(200).send({
        error: null,
        result: document,
        message: 'DID Document obtained successfully.',
      });
    }
    const { txid: iptxid, vout: ipvout } = vin[0];
    const iptxData = (await btcClient('getrawtransaction', [iptxid, true]), isOmni)
      .result;
    const {
      scriptPubKey: { addresses },
    } = iptxData.vout[ipvout];
    const defaultCapability = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: `${did}`,
      publicKey: [
        {
          id: `${did}#auth`,
          controller: `${did}`,
          type: 'EcdsaSecp256k1VerificationKey2019',
          publicKeyBase58: addresses[0],
        },
        {
          id: `${did}#vc-pubkey`,
          controller: `${did}`,
          type: 'EcdsaSecp256k1VerificationKey2019',
          publicKeyBase58: addresses[0],
        },
      ],
      authentication: ['#auth'],
      assertionMethod: ['#vc-pubkey'],
    };
    return res.status(200).send({
      error: null,
      message: 'DID Doucment obtained successfully.',
      result: defaultCapability,
    });
  } catch (errorT) {
    return res.status(500).send({ result: false, error: errorT.message });
  }
};
