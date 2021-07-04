const bitcoin = require('bitcoinjs-lib');
const bitcoinMessage = require('bitcoinjs-message');
const { randomBytes } = require('crypto');
const Web3 = require('web3');
const mongoose = require('mongoose');

const { btcClient, helpers } = require('../utils/util');
const i18n = require('../../i18n');
const { credentialTypes } = require('../config');
const ethDID = require('./eth.did.service');
const ipfs = require('../ipfs');
const env = require('../config/eth.env.json');
const {
  BTC_DUST,
  NO_OF_TX_OUTPUTS,
  FINAL_NO_OF_TX_INPUTS,
  FINAL_NO_OF_TX_OUTPUTS,
  OMNI_BLOCKCHAIN,
  PRIVATE_DB_MONGO,
  ALLOWED_CHAINS,
} = require('../utils/constants');
const DIDModel = require('../models/did.model');

const web3 = new Web3(new Web3.providers.HttpProvider(env.ethNodeURL));

const api = exports;

/**
 * API to prepare a transaction for DID creation.
 * @returns {object}
 */
api.prepareTransaction = async (req, res) => {
  const { blockchain } = req.body;
  try {
    if (blockchain === 'eth') {
      const { type } = req.body;
      if (!type) {
        return res
          .status(400)
          .send({ result: null, error: i18n('Missing parameters') });
      }
      if (type === 'create') {
        const { didDoc, publicKey } = req.body;
        if (!didDoc || !publicKey) {
          return res
            .status(400)
            .send({ result: null, error: i18n('Missing parameters') });
        }
        const rawTx = await ethDID.create(didDoc, publicKey);
        return res.status(200).send({
          message: 'RawTx created successfully.',
          result: rawTx.data,
          error: null,
        });
      }
      if (type === 'update') {
        const { didDoc, cid, publicKey } = req.body;
        if (!didDoc || !cid || !publicKey) {
          return res
            .status(400)
            .send({ result: null, error: i18n('Missing parameters') });
        }
        const rawTx = await ethDID.setMetadata(publicKey, cid, didDoc);
        return res.status(200).send({
          message: 'RawTx created successfully.',
          result: rawTx.data,
          error: null,
        });
      }
      if (type === 'transfer') {
        const { publicKey, newOwner, cid } = req.body;
        if (!newOwner || !cid || !publicKey) {
          return res
            .status(400)
            .send({ result: null, error: i18n('Missing parameters') });
        }
        const rawTx = await ethDID.setController(publicKey, newOwner, cid);
        return res.status(200).send({
          message: 'RawTx created successfully.',
          result: rawTx.data,
          error: null,
        });
      }
      if (type === 'delete') {
        const { publicKey, cid } = req.body;
        if (!publicKey || !cid) {
          return res
            .status(400)
            .send({ result: null, error: i18n('Missing parameters') });
        }
        const rawTx = await ethDID.deleteDID(publicKey, cid);
        return res.status(200).send({
          message: 'RawTx created successfully.',
          result: rawTx.data,
          error: null,
        });
      }
    }
    if (blockchain === PRIVATE_DB_MONGO) {
      const { creator } = req.body;
      if (!creator) {
        return res
          .status(400)
          .send({ result: null, error: i18n('Missing parameters') });
      }
      const _id = new mongoose.Types.ObjectId();
      const doc = helpers.prepareDoc(_id, creator);
      const addedDoc = await new DIDModel(doc).save();
      return res.status(200).send({
        message: 'DID Doc prepared and added successfully.',
        result: addedDoc._id,
        error: null,
      });
    }
    const { didCreator, didUpdater } = req.body;
    if (!didCreator || !didUpdater) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }

    const amount = BTC_DUST;
    let fee = 0;
    const unspents = (
      await btcClient('listunspent', [1, 9999999, [didCreator]])
    ).result;
    if (unspents.length) {
      const inputs = [];
      const outputs = {};
      fee = helpers.calculateFee(unspents.length, NO_OF_TX_OUTPUTS);
      let totalAmount = 0;
      unspents.forEach((x) => {
        inputs.push({ txid: x.txid, vout: x.vout });
        totalAmount += x.amount;
      });
      if (totalAmount >= Number(amount) + Number(fee)) {
        const changeAmt = (
          totalAmount - (Number(amount) + Number(fee))
        ).toFixed(8);
        outputs[didUpdater] = String(amount);
        if (Number(changeAmt) > 0) {
          outputs[didCreator] = changeAmt;
        }
        const rawTx = await btcClient('createrawtransaction', [
          inputs,
          outputs,
        ]);
        if (rawTx.result) {
          return res.status(200).send({
            message: 'Tx created successfully.',
            result: rawTx.result,
            error: null,
          });
        }
        return res.status(500).send({
          result: null,
          error: i18n('Error occurred while creating a raw transaction.'),
        });
      }
      return res.status(500).send({
        result: null,
        error: i18n('Sender does not have sufficient balance.'),
      });
    }
    fee = helpers.calculateFee(FINAL_NO_OF_TX_INPUTS, FINAL_NO_OF_TX_OUTPUTS);
    return res.status(500).send({
      result: null,
      error: i18n(
        `Sender does not have funds. Please fund this address "${didCreator}" with ${fee} BTC.`,
      ),
    });
  } catch (errorT) {
    return res.status(500).send({ result: false, error: errorT.message });
  }
};

/**
 * API to upload and store a document on IPFS.
 * @returns {object}
 */
api.storeDoc = async (req, res) => {
  try {
    const resp = await ipfs.upload(req);
    return res.status(200).send({
      cid: resp.data.cid,
      message: 'DID document uploaded',
      error: null,
    });
  } catch (errorT) {
    return res.status(500).send({ result: false, error: errorT.message });
  }
};

/**
 * API to broadcast a signed transaction onto BTC or ETH network.
 * @returns {object}
 */
api.broadcast = async (req, res) => {
  try {
    const { signedTx, blockchain } = req.body;
    if (!signedTx) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }
    let sentTx;
    const isOmni = blockchain === OMNI_BLOCKCHAIN;
    if (blockchain === 'eth') {
      sentTx = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
    } else {
      sentTx = await btcClient('sendrawtransaction', [signedTx], isOmni);
    }
    return res.status(200).send({
      error: null,
      message: 'Txn sent successfully.',
      result: sentTx,
    });
  } catch (errorT) {
    return res.status(500).send({ result: false, error: errorT.message });
  }
};

/**
 * API to issue a new claim.
 * @returns {object}
 */
api.issueNewClaim = async (req, res) => {
  try {
    const {
      attestorDID,
      requestorDID,
      claimType,
      claimData,
      attestorName,
      attestorPublicKey,
      attestorPrivateKey,
      network: givenNetwork,
      blockchain,
    } = req.body;
    if (
      !attestorDID
      || !requestorDID
      || !claimType
      || !claimData
      || !attestorPublicKey
      || !attestorPrivateKey
      || !attestorName
    ) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }
    if (!credentialTypes.includes(claimType)) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Invalid claimType sent.') });
    }
    let [part1, part2, part3] = attestorDID.split(':');
    if (
      part1 !== 'did'
      || part2 !== 'mdip'
      || !ALLOWED_CHAINS.includes(part3.split('-')[0])
    ) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Invalid DID sent.') });
    }
    [part1, part2, part3] = requestorDID.split(':');
    if (
      part1 !== 'did'
      || part2 !== 'mdip'
      || !ALLOWED_CHAINS.includes(part3.split('-')[0])
    ) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Invalid DID sent.') });
    }
    let claim = {};
    const validFrom = new Date().toISOString();
    const validUntil = new Date(
      Date.now() + 180 * 24 * 60 * 60 * 1000,
    ).toISOString(); // 6-months validity.
    if (
      (claimType === 'ageOver18' || claimType === 'ageOver21' || claimType === 'isPlatformXUser')
      && claimData[claimType]
    ) {
      claim = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        id: attestorDID,
        type: ['VerifiableCredential', claimType],
        issuer: {
          id: attestorDID,
          name: attestorName,
        },
        issuanceDate: validFrom,
        expirationDate: validUntil,
        credentialSubject: {
          id: requestorDID,
          [claimType]: true,
        },
      };
    }
    const message = JSON.stringify(claim);
    let signature;
    if (blockchain === 'eth') {
      const web3Instance = new Web3(new Web3.providers.HttpProvider());
      signature = await web3Instance.eth.accounts.sign(
        message,
        `0x${attestorPrivateKey}`,
      );
    } else if (blockchain === 'mongodb') {
      const network = bitcoin.networks.bitcoin;
      const keyPair = bitcoin.ECPair.fromPrivateKey(Buffer.from(attestorPrivateKey, 'hex'), { network });
      signature = bitcoinMessage.sign(
        message,
        Buffer.from(attestorPrivateKey, 'hex'),
        keyPair.compressed,
        { extraEntropy: randomBytes(32) },
      );
    } else {
      let network = bitcoin.networks.testnet;
      if (givenNetwork === 'mainnet') {
        network = bitcoin.networks.bitcoin;
      }
      const keyPair = bitcoin.ECPair.fromWIF(attestorPrivateKey, network);
      const obatinedPrivKey = keyPair.privateKey;

      signature = bitcoinMessage.sign(
        message,
        obatinedPrivKey,
        keyPair.compressed,
        { extraEntropy: randomBytes(32) },
      );
    }

    claim.proof = {
      type: 'EcdsaSecp256k1VerificationKey2019',
      created: validFrom,
      proofPurpose: 'assertionMethod',
      verificationMethod: attestorPublicKey,
      // This will be more generic e.g: did:mdip:btc-1234#pubkey1 so that id does not get hardcoded.
      jws: signature.toString('base64'),
    };
    return res.status(200).send({
      error: null,
      message: 'Verifiable credential generated successfully.',
      result: JSON.stringify(claim),
    });
  } catch (errorT) {
    return res.status(500).send({ result: false, error: errorT.message });
  }
};
