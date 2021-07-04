const request = require('request');
const Web3 = require('web3');
const fs = require('fs');

const { txidToTxref } = require('../utils/tx-ref');
const { _prepareTransaction } = require('./preparer');
const { _signTx, _createVerifiablePresentation } = require('./signer');
const {
  BTC_BLOCKCHAIN,
  ETH_BLOCKCHAIN,
  OMNI_BLOCKCHAIN,
  PRIVATE_DB_MONGO,
  ALLOWED_CHAINS,
} = require('../utils/constants');

const client = exports;

const web3 = new Web3();

const upload = ({ url, path }) => new Promise((resolve, reject) => {
  const r = request.post(url, (err, _, resp) => {
    if (err) {
      reject(err);
      return;
    }
    const respParsed = JSON.parse(resp);
    if (respParsed && respParsed.cid) {
      resolve(respParsed);
    } else {
      reject(respParsed && respParsed.error);
    }
  });
  const form = r.form();
  form.append('file', fs.createReadStream(path));
});

class MDIP {
  constructor(options) {
    // TODO: validate options
    this.server = options.server;
    if (!this.server) {
      throw new Error('server not provided');
    }
  }

  call(endpoint, params) {
    const req = {
      url: `${this.server}/${endpoint}`,
      method: params ? 'POST' : 'GET',
      body: params,
      json: true,
    };
    return new Promise((resolve, reject) => {
      request(req, (err, _, resp) => {
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
  }

  async getServerInfo() {
    return this.call('serverinfo');
  }

  /**
   * Method to fetch utxos and associated raw transactions.
   * @param {string} creator
   * @param {string} blockchain
   * @returns {Object}
   */
  async getUtxos(creator, blockchain) {
    const { result } = await this.call('getutxos', { address: creator, blockchain });
    return result;
  }

  prepareTransaction(didInputs, utxoData) {
    return _prepareTransaction(this.server, didInputs, utxoData);
  }

  /**
   * Method to sign an ETH transaction.
   * @param {string} privKey
   * @param {string} rawTx
   * @param {string} pubKey
   * @param {{
   *  blockchain: string
   *  network: string
   * }} param0
   * @returns {Object}
   */ // network is no longer needed as it will be fetched from the config. PS this is client only.
  // eslint-disable-next-line class-methods-use-this
  async signTx(privKey, rawTx, pubKey, { blockchain, network } = {}) {
    return _signTx(privKey, rawTx, pubKey, { blockchain, network });
  }

  /**
   * Method to broadcast an already signed transaction.
   * @param {string} signedTx
   * @param {string} blockchain
   * @returns {string}
   */
  async broadcast(signedTx, blockchain) {
    const { result } = await this.call('broadcast', { signedTx, blockchain });
    return result;
  }

  /**
   * Create a new MDIP DID.
   * @param {string} blockchain
   * @param {string} network
   * @param {string} tx
   * @returns {string}
   */
  async createNewMdipDID(blockchain, network, tx) {
    if (blockchain === BTC_BLOCKCHAIN || blockchain === OMNI_BLOCKCHAIN) {
      // undefined is unavoidable for now due to the tx encoding logic
      const txRef = await txidToTxref(tx, network, undefined, this.server, blockchain);
      const extractedRef = txRef.split(':')[1];
      let DID = `did:mdip:btc-${extractedRef}`;
      if (blockchain === OMNI_BLOCKCHAIN) {
        DID = `did:mdip:omni-${extractedRef}`;
      }
      return DID;
    }
    if (blockchain === ETH_BLOCKCHAIN) {
      const event = await web3.eth.abi.decodeLog(
        [
          {
            indexed: false,
            name: 'id',
            type: 'bytes32',
          },
          {
            indexed: false,
            name: 'metadata',
            type: 'bytes32',
          },
        ],
        tx.logs[0].data,
        tx.logs[0].topics,
      );
      const extractedRef = event.id;
      return `did:mdip:eth-${extractedRef}`;
    }
    if (blockchain === PRIVATE_DB_MONGO) {
      return `did:mdip:${PRIVATE_DB_MONGO}-${tx}`;
    }
    return null;
  }

  /**
   * Method to issue a new Verifiable Claim.
   * @param {{
   *  blockchain: string
   *  attestorDID: string
   *  requestorDID: string
   *  claimType: string
   *  claimData: Object
   *  attestorName: string
   *  attestorPublicKey: string
   *  attestorPrivateKey: string
   * }} param0
   * @returns {Object}
   */
  async issueNewClaim({
    blockchain,
    attestorDID,
    requestorDID,
    claimType,
    claimData,
    attestorName,
    attestorPublicKey,
    attestorPrivateKey,
  }) {
    if (ALLOWED_CHAINS.includes(blockchain)) {
      const issuedClaim = await this.call('issuenewclaim', {
        blockchain,
        attestorDID,
        requestorDID,
        claimType,
        claimData,
        attestorName,
        attestorPublicKey,
        attestorPrivateKey,
      });
      return issuedClaim;
    }
    return null;
  }

  /**
   * Method to create a new verifiable presentation.
   * @param {string} blockchain
   * @param {string} vc
   * @param {string} publicKey
   * @param {string} privateKey
   * @param {string} challenge
   * @param {string} domain
   * @param {string} givenNetwork
   * @param {Object} randomBytes
   * @returns {Object}
   */
  // eslint-disable-next-line class-methods-use-this
  async createVerifiablePresentation(
    blockchain,
    vc,
    publicKey,
    privateKey,
    challenge,
    domain,
    givenNetwork,
    randomBytes,
  ) {
    return _createVerifiablePresentation(
      blockchain,
      vc,
      publicKey,
      privateKey,
      challenge,
      domain,
      givenNetwork,
      randomBytes,
    );
  }

  /**
   * Method to store DidDoc on IPFS.
   * @param {string} didDocPath
   * @returns {Object}
   */
  async storeDidDoc(didDocPath) {
    const response = await upload({
      url: `${this.server}/storeDoc`,
      path: didDocPath,
    });
    return response;
  }
}

client.MDIP = MDIP;
