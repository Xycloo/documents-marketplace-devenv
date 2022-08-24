// stellar Turrets compatible contract prototype for sTeX's decentralized documents marketplace
// reference url: https://stex.xycloo.com/#marketplace
// developed by the Xycloo team: https://xycloo.com/

// some consts => the only ones hard-coded in this "contract"

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const NETWORK = "TESTNET";
const MAX_SIGNERS = 10;
const stex_middleman = "GASOAL22ZOQ7HU6DEEHHRHSKEXIQ4U6WRBH2JUGY5IEDPYI5GPDSZDEH";

var atob = require("atob");
const {
    Server,
    Networks,
    TransactionBuilder,
    Operation,
    Asset,
    BASE_FEE,
    Keypair,
} = require('stellar-sdk');



const server = new Server(HORIZON_URL);

const beginSponsoringOp = (sponsored, source) => {
    return Operation.beginSponsoringFutureReserves({
	sponsoredId: sponsored,
	source: source
    })
}

const endSponsoringOp = (source) => {
    return Operation.endSponsoringFutureReserves({
	source: source
    })
}

function isNumeric(str) {
    if (typeof str != "string") return false
    return !isNaN(str) && !isNaN(parseFloat(str))
}

const getTx = (source, fee, timebounds) => {
    let tx = new TransactionBuilder(source, {
        fee: fee,
	timebounds: timebounds,
        networkPassphrase: Networks[NETWORK],
        withMuxing: true,
    });
    
    return tx
}

const getSale = (document_account) => {
    let active_signers = document_account.signers.filter(signer => signer.weight > 0);
    if (active_signers > 1) {
	throw "more than 1 signer, exiting"
    };
    const to_match = active_signers[0];

    if (to_match.key != stex_middleman) {
	throw "middleman signer not found, document is not for sale"
    }

    const price = document_account.data_attr.price;
    const seller = document_account.data_attr.seller;

    if (!price) {
	throw "price not found"
    }

    if (!seller) {
	throw "seller not found"
    }

    return {
	price: parseFloat(atob(price)),
	seller: atob(seller)
    }
}

const sellerExists = async (seller) => {
    try {
	await server.loadAccount(seller);
	return true
    } catch (e) {
	false
    }

}

// 0. check if document is for sale (has the turret as only signer)
// 1. check if document has seller and price in data
// 2. remove middleman signer
// 3. add buyer as signer
// 4. buyer pays seller price xlm
// 5. remove seller and price from managedata

const buyOffer = async (body) => {
    const tb = body.timebounds;
    const fee = body.fee;
    const buyer = body.buyerPK;
    const document = body.documentPK;
    let ops = [];
    
    const middleman_account = await server.loadAccount(stex_middleman);
    const document_account = await server.loadAccount(document);

    const {price, seller} = getSale(document_account);     // checking if the document is for sale
                                                           // and if the doc holds price and seller data
    
    const remove_middleman_signer_op = Operation.setOptions({
	                                                   // removing the middleman's signer,
	                                                   // meaning turrets no longer control the doc
	signer: {
	    ed25519PublicKey: stex_middleman,
	    weight: 0
	},
	source: document
    });
    ops.push(remove_middleman_signer_op);

    let buyer_pay_seller_op;                                // the buyer pays the seller from the doc's data
    if (await sellerExists(seller)) {                       // the seller can either exist on-chain or only be
	buyer_pay_seller_op = Operation.payment({           // an ed25519 public key
	    destination: seller,
	    asset: Asset.native(),
	    amount: price.toString(),
	    source: buyer
	});
	ops.push(buyer_pay_seller_op);
    } else {
	buyer_pay_seller_op = Operation.createAccount({
	    destination: seller,
	    startingBalance: price.toString(),
	    source: buyer
	});
	ops.push(buyer_pay_seller_op);
    }
    
    ops.push(beginSponsoringOp(document, buyer))            // sponsor the new signer (the buyer's)

    const add_buyer_signer_op = Operation.setOptions({
	signer: {
	    ed25519PublicKey: buyer,
	    weight: 10,
	},
	source: document
    });
    ops.push(add_buyer_signer_op);

    ops.push(endSponsoringOp(document));                    // end sponsoring
    
    const remove_seller_op = Operation.manageData({         // annulling seller and price data
	                                                    // since they are no-longer needed
	                                                    // still need to evaluate if it's better
	                                                    // to directly remove and then re-sponsor
	name: "seller",
	value: "",
	source: document
    });
    ops.push(remove_seller_op);
    
    const remove_price_op = Operation.manageData({
	name: "price",
	value: "",
	source: document
    });
    ops.push(remove_price_op);


    let tx = getTx(middleman_account, fee, tb);

    for (op of ops) {
	tx.addOperation(op);
    }

    return tx.build().toXDR();
};


// 0. remove all other signers
// 1. add stex middleman as signer
// 2. add seller and price to document's manage data (sponsored by stex middleman)
// 3. all accounts the stex middleman is a signer to are documents for sale

const sellOffer = async (body) => {
    const tb = body.timebounds;
    const fee = body.fee;
    const seller = body.sellerPK;
    const price = body.price;
    const document = body.documentPK;
    let ops = [];
    
    if (!isNumeric(price)) {
	throw "invalid price"
    };

    const document_account = await server.loadAccount(document);
    const middleman_account = await server.loadAccount(stex_middleman);
    const document_signers = document_account.signers;

    if (document_signers.length >= MAX_SIGNERS) {                   // the contract will only remove up to MAX_SIGNERS
	throw "too many signers on document, remove them manually"; // if there are more the user will have to remove
								    // them manually
    }
    
    for (signer of document_signers) {				   // removing all other singers so only turrets control
								   // the document
	let remove_signer_op;

	if (signer.key == document) {
	    remove_signer_op = null
	} else if (signer.type == "sha256_hash") {
	    remove_signer_op = Operation.setOptions({
		signer: {
                    sha256Hash: signer.key,
                    weight: 0
		},
		source: document
	    })

	} else if (signer.type == "preauth_tx") {
	    remove_signer_op = Operation.setOptions({
		signer: {
                    preAuthTx: signer.key,
                    weight: 0
		},
		source: document
	    })

	} else if (signer.type == "ed25519_public_key") {
	    remove_signer_op = Operation.setOptions({
		signer: {
                    ed25519PublicKey: signer.key,
                    weight: 0
		},
		source: document
            })
	}
	
	ops.push(remove_signer_op);
    }

    ops.push(beginSponsoringOp(document, stex_middleman))	// sponsoring

    const add_signer_op = Operation.setOptions({		// making sure the master weight is 0
	                                                        // also adding stex_middleman's signer
								// which means adding the turrets as signers
	masterWeight: 0,
	lowThreshold: 10,
	mediumThreshold: 10,
	highThreshold: 10,
	signer: {
	    ed25519PublicKey: stex_middleman,
	    weight: 10,
	},
	source: document
    })
    ops.push(add_signer_op);

    ops.push(endSponsoringOp(document))

    ops.push(beginSponsoringOp(document, stex_middleman))
    
    const add_seller_op = Operation.manageData({	       // adding the doc's seller and price
							       // to the account's data attributes
	name: "seller",
	value: `${seller}`,
	source: document
    });
    ops.push(add_seller_op);

    ops.push(endSponsoringOp(document))

    ops.push(beginSponsoringOp(document, stex_middleman))

    const add_price_op = Operation.manageData({
	name: "price",
	value: `${price}`,
	source: document
    });
    ops.push(add_price_op);

    ops.push(endSponsoringOp(document))

    
    let tx = getTx(middleman_account, fee, tb)

    ops = ops.filter(op => op != null);
    
    for (op of ops) {
        tx.addOperation(op);
    }
    
    return tx.build().toXDR()
    
}


// lookup table for marketplace actions
const actions_lookup = {
    "sellOffer": sellOffer,
    "buyOffer": buyOffer
}


module.exports = async (body) => {                   // handler call
    const action_name = body.action;

    return actions_lookup[action_name](body)
};



// sample sell offer
/*
await module.exports({
    "timebounds":{"minTime":0,"maxTime":1660612827},
    "fee":"200",
    "action":"sellOffer",
    "sellerPK": "GBZKEIDHUH7IUVTACKACWNGUJHNO4YMJBW37UWIGKG5UOFT7LOD7WK5U",
    "price": "100",
    "documentPK": "GDZ2CB4BL55JQJOPTXVMHCK6RH4OGPCSYQJ33RWAVWZKASFAQJVNVEA2"
    }
)
*/


// sample buy offer
/*
await module.exports({
    "timebounds":{"minTime":0,"maxTime":1660612827},
    "fee":"200",
    "action":"buyOffer",
    "buyerPK": "GBZU7CHZOSYB6W3B4RCW27RYQDKYUSGCZSAS4WKTFJFREOQZBCBSE7XD",
    "documentPK": "GDZ2CB4BL55JQJOPTXVMHCK6RH4OGPCSYQJ33RWAVWZKASFAQJVNVEA2"
    }
)
*/
