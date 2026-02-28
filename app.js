import Flutterwave from "flutterwave-node-v3";
import dotenv from "dotenv";
dotenv.config();

const flw = new Flutterwave(
	process.env.FLW_PUBLIC_KEY,
	process.env.FLW_SECRET_KEY
);
// Dummy data for the process

const dummyData = {
	country: 'RW',
	account_number: '6823208604',
	bank_name: 'Ecobank', 
	amount: 24,
	narration: 'Subscription Payment',
	currency: 'USD',
	reference: 'unique-transfer-ref-9p8',
	transfer_id: null, // This will store the transfer ID from the created transfer
	transaction_id: null, // This will store the transaction ID
	account_name: 'MUSTAFA KHAMIS',
};
const runFullTransferFlow = async () => {
	try {
		// Step 1: Get Bank Code for the transfer
		console.log('Fetching Bank List...');
		const bankCodeResponse = await flw.Bank.country({
			country: dummyData.country,
			account_bank: dummyData.bank_name,
		});
		console.log(bankCodeResponse);

		// Filter the bank list for the bank with name "Access Bank"
		const selectedBank = bankCodeResponse.data.find(
			(bank) => bank.name === dummyData.bank_name
		);

		if (!selectedBank) {
			throw new Error(
				`Bank code with name ${dummyData.bank_name} not found`
			);
		}

		console.log(
			`Bank Found: ${selectedBank.name} with code ${selectedBank.code}`
		);

		// Step 2: Resolve Account details to confirm they are valid
		console.log('Verifying Account Details...');
		const resolveAccountResponse = await flw.Misc.verify_Account({
			account_number: dummyData.account_number,
			account_bank: selectedBank.code,
		});
		console.log('Account Verified:', resolveAccountResponse);

		// Step 3: Initiate a transfer
		console.log('Initiating Transfer...');
		const transferResponse = await flw.Transfer.initiate({
			account_bank: selectedBank.code,
			account_number: dummyData.account_number,
			amount: dummyData.amount,
			narration: dummyData.narration,
			currency: dummyData.currency,
			reference: dummyData.reference,
			callback_url: 'https://makzom.com/callback',
			debit_currency: 'USD',
		});
		console.log('Transfer Initiated:', transferResponse);

		// Save the transfer ID for future steps
		dummyData.transfer_id = transferResponse.data.id;

		// Step 4: Get details of the transfer
		console.log('Fetching Transfer Details...');
		const fetchTransferResponse = await flw.Transfer.get_a_transfer({
			id: dummyData.transfer_id,
		});
		console.log('Transfer Details:', fetchTransferResponse);

		// Step 5: Comparing to Verify the transaction
		console.log('Verifying Transaction Details...');
		const matches =
			fetchTransferResponse.data.account_number ===
				dummyData.account_number &&
			fetchTransferResponse.data.amount === dummyData.amount &&
			fetchTransferResponse.data.narration === dummyData.narration &&
			fetchTransferResponse.data.reference === dummyData.reference &&
			fetchTransferResponse.data.currency === dummyData.currency &&
			fetchTransferResponse.data.full_name === dummyData.account_name; // Add any other necessary fields
		console.log(matches);
		if (matches) {
			console.log(
				'Transaction details match with dummy data. Verification successful.'
			);
		} else {
			console.log(
				'Transaction details do not match with dummy data. Verification failed.'
			);
		}
	} catch (error) {
		console.error(
			'Error during transfer flow:',
			error.response ? error.response.data : error
		);
	}
};

runFullTransferFlow();