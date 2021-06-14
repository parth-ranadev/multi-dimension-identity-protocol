const bitcoin = require('bitcoinjs-lib');
const bitcoinMessage = require('bitcoinjs-message');
const Web3 = require('web3');

const {
  BTC_BLOCKCHAIN,
  ETH_BLOCKCHAIN,
  OMNI_BLOCKCHAIN,
  TESTNET,
} = require('../utils/constants');

const signer = exports;

const web3 = new Web3();

signer._signTx = async (privKey, rawTx, pubKey, { blockchain, network } = {}) => {
  if (blockchain === BTC_BLOCKCHAIN || blockchain === OMNI_BLOCKCHAIN) {
    const nw = network === TESTNET
      ? bitcoin.networks.testnet
      : bitcoin.networks.bitcoin;
    const psbtObj = bitcoin.Psbt.fromHex(rawTx);
    const txSigner = bitcoin.ECPair.fromWIF(privKey, nw);
    psbtObj.signAllInputs(txSigner);
    const valid = psbtObj.validateSignaturesOfAllInputs();
    if (valid) {
      psbtObj.finalizeAllInputs();
      const txHex = psbtObj.extractTransaction().toHex();
      return { success: true, data: txHex };
    }
  } else {
    const web3Instance = new Web3(
      new Web3.providers.HttpProvider(rawTx.result.provider),
    );
    web3Instance.eth.accounts.wallet.add(privKey);
    const tx = await web3Instance.eth.accounts.signTransaction(
      {
        from: pubKey,
        gasPrice: rawTx.result.gasPrice,
        gas: rawTx.result.gasLimit,
        to: rawTx.result.contractAddress,
        data: rawTx.result.data,
      },
      privKey,
    );
    web3Instance.eth.accounts.wallet.clear();
    return { success: true, data: tx };
  }
  return null;
};

signer._createVerifiablePresentation = async (
  blockchain,
  vc,
  publicKey,
  privateKey,
  challenge,
  domain,
  givenNetwork,
  randomBytes,
) => {
  const parsedVC = JSON.parse(vc);
  const vp = {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    type: 'VerifiablePresentation',
    verifiableCredential: [parsedVC],
  };
  const message = JSON.stringify(vp);
  let signature = null;
  if (blockchain === BTC_BLOCKCHAIN) {
    let network = bitcoin.networks.testnet;
    if (givenNetwork === 'mainnet') {
      network = bitcoin.networks.bitcoin;
    }
    const keyPair = bitcoin.ECPair.fromWIF(privateKey, network);
    const obatinedPrivKey = keyPair.privateKey;
    signature = bitcoinMessage.sign(
      message,
      obatinedPrivKey,
      keyPair.compressed,
      { extraEntropy: randomBytes(32) },
    );
  }
  if (blockchain === ETH_BLOCKCHAIN) {
    signature = (await web3.eth.accounts.sign(message, `0x${privateKey}`)).signature;
  }
  if (blockchain === 'mongodb') {
    const network = bitcoin.networks.bitcoin;
    const keyPair = bitcoin.ECPair.fromPrivateKey(Buffer.from(privateKey, 'hex'), { network });
    signature = bitcoinMessage.sign(
      message,
      Buffer.from(privateKey, 'hex'),
      keyPair.compressed,
      { extraEntropy: randomBytes(32) },
    );
  }
  if (signature) {
    const createdAt = new Date().toISOString();
    vp.proof = {
      type: 'EcdsaSecp256k1VerificationKey2019',
      created: createdAt,
      proofPurpose: 'authentication',
      verificationMethod: publicKey, // TODO: use DID fragments to point to the public key.
      challenge,
      domain,
      jws: signature.toString('base64'),
    };
    return vp;
  }
  return null;
};
