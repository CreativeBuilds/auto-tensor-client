// client can either be a perma miner, or intended to serve models
// this is set by an enviroment variable called NODE_ENV
// this is socket.io-client where we will send a Bearer authorization header.
import { connect } from 'socket.io-client';
import { nanoid } from 'nanoid';
import { statSync, readFileSync } from 'fs';
import { getSubdirectories } from './_helpers/getSubdirectories.js';
import { spawn } from 'child_process';

const TYPE = process.env.NODE_ENV || 0;
const ID = process.env.ID || TYPE ? `miner-${nanoid()}` : `model-${nanoid()}`;
// comma split array of numbers
const GPUS = (new Array(process.env.GPUS || 1).fill(null)).reduce((acc, val, idx) => {
    acc[idx] = {
        running_miner: false,
        models: [],
    };
    return acc;
}, {});
const GPU_TYPE = process.env.GPU_TYPE;
/**
 * GPU TYPE IS ONE OF THE FOLLOWING:
 * 
 * 3090, a4000, a5000
 **/
 const TOTAL_MODELS_PER_GPU = GPU_TYPE === "a6000" ? 4 : GPU_TYPE === '3090' || GPU_TYPE === "a5000" ? 3 : 2;

console.log(GPUS);

const headers = {authorization: `Bearer abc`}
const url = 'http://localhost:3000';
const opts = { headers: headers, extraHeaders: headers };

const connection = connect(url, opts);
let subdirs = GetWalletNames();
// check for the coldkeypub.txt file in the sub directory under the wallets directory
let cold_key = JSON.parse(readFileSync(process.env.HOME + '/.bittensor/wallets/miners/coldkeypub.txt').toString());
let keys;
if(subdirs.includes('miners')) {
    keys = GetKeysForWallet('miners').map(key => {
        return {
            hotkeyfilename: key.filename.split("/").pop(),
            address: key.json.ss58Address,
        }
    });
    console.log(keys, "keys");
} else {
    keys = [];
}


const self = {
    // 0 is perma miner (3090), 1 is model server (a5000)
    type: TYPE, // this could be a perma miner, or intended to serve models (0 || 1)
    id: ID, // this needs to stay the same after reconnects
    wallet: cold_key["ss58Address"],
    keys: keys,
    needs_cold: !subdirs.includes('miners'),
    max_models: TYPE ? TOTAL_MODELS_PER_GPU : undefined,
}

console.log(self);

function CreateHotKey(name, data) {
    if(!data.hasOwnProperty('__comment')) return;

    const sanitized_data = {
        address: data.address,
        mnemonic: data.mnemonic,
        accountId: data.accountId,
        publicKey: data.publicKey,
        secretPhrase: data.secretPhrase,
        secretSeed: data.secretSeed,
        ss58Address: data.ss58Address,
    }

    // check all values to make sure they're proper
    let all_valid = Object.values(sanitized_data).reduce((acc, val) => {
        return acc && !!val && typeof val === 'string';
    }, true);

    if(!all_valid) throw new Error("Improper input for CreateHotKey.");


    // check if there is already an existing file here
    if(!statSync(`${process.env.HOME}/.bittensor/wallets/miners/hotkeys/${name}`).isFile()) {
        // write the contents of data to a file named $name
        fs.writeFileSync(`${process.env.HOME}/.bittensor/wallets/miners/hotkeys/${name}`, JSON.stringify(data, 0, 4));
    }
    else throw new FileExistsError("File already exists. Please provide a unique name.");

    return sanitized_data;
}

let my_tasks = {};

// once connected to server, send self information as a "register" message
connection.on('connect', () => {
    connection.emit('register', self);

    // listen for commandds from server
    connection.on('cold', ({
        coldkeypub,
        coldkey,
    }) => {

        // check if file exists, if not create it and write coldkey to it
        const coldkeypubPath = `${process.env.HOME}/.bittensor/wallets/miners/coldkeypub.txt`;

        if (fs.existsSync(coldkeypubPath)) return;

        // create the miners subdirectory if it does not exist
        if (!fs.existsSync(`${process.env.HOME}/.bittensor/wallets/miners`)) {
            fs.mkdirSync(`${process.env.HOME}/.bittensor/wallets/miners`);
        }

        // save to .bittensor/miners/
        fs.writeFile(`${process.env.HOME}/.bittensor/wallets/miners/coldkeypub.txt`, coldkeypub);
        fs.writeFile(`${process.env.HOME}/.bittensor/wallets/miners/coldkey`, coldkey);
    });

    connection.on("task", (task) => {
        const hotkeyfilename = task.hotkey.name;
        const hotkey_path = `${process.env.HOME}/.bittensor/wallets/miners/hotkeys/${hotkeyfilename}`;
        let hotkey;
        if(fs.existsSync(hotkey_path)) {
            hotkey = JSON.parse(readFileSync(hotkey_path).toString());
        } else {
            hotkey = CreateHotKey(task.hotkey.name, task.hotkey.data);
        }

        if(!!my_tasks[task.hotkey.name]) {
            my_tasks[task.hotkey.name].process.exit('SIGINT');
            console.warn(`Stopping...`, my_tasks[task.hotkey.name]);
            delete my_tasks[task.hotkey.name];
        }
        console.log(`Hot key loaded! `, hotkey);
        
        const isRegistered = task.is_registered;
        
        if(!isRegistered) {
            // start registering model
            let {$std, process} = StartRegistration(task, task.hotkey.name);
            console.log("Starting to register");
            my_tasks[task.hotkey.name] = {
                task,
                $std,
                process,
            }
                
        } else {
            // start proxying model
            let {$std, process} = StartModel(task, task.hotkey.name);
            console.log("Running model");
            my_tasks[task.hotkey.name] = {
                task,
                $std,
                process,
            }
        }
    })
});

// create an observable for all observables
//  {[name: string]: Observable}
const $allRegistrationProcesses = new Observable({});
const $allModelProcesses = new Observable({});

function StartRegistration(task, hotkeyname) {
    // this will spawn a new process running "btcli register --cuda --cuda.dev_id=<DEVICE_NUMBERS>"
    const ids = task.gpu_idxs.join(",");
    // call spawn
    let child = spawn("btcli", [
        "register",
        "--cuda",
        "--cuda.dev_id=" + ids,
        "--subtensor.chain_endpoint 95.217.192.33:9944",
        "--subtensor.network local",
        "--wallet.name miners",
        "--wallet.hot " + hotkeyname,
    ]);
    // turn child into rxjs observable with "from"
    let current = $allRegistrationProcesses.getValue();

    let $std = new Observable((observer) => {
        child.stdout.on('data', (data) => {
            observer.next(data.toString());
        });
        child.stdout.on('error', error => observer.error(error))
        child.stdout.on('end', () => observer.complete());
    });

    $allRegistrationProcesses.next({...current, [hotkeyname]: {
        $std,
        process: child,
    }});

    return {
        $std,
        process: child,
    }
    
}

function StartModel(task, hotkeyname) {
    const ids = task.gpu_idxs.join(",");
    // call spawn

    /** Command looks llike
     * python3 -u ~/.bittensor/bittensor/bittensor/_neuron/text/core_server/main.py --logging.debug --logging.trace  --subtensor.chain_endpoint 95.217.192.33:9944 --subtensor.network local --axon.port $RUNPOD_TCP_PORT_70008 --neuron.device cuda:3 --neuron.model_name EleutherAI/gpt-neo-1.3B --wallet.name default2 --wallet.hotkey default4 --neuron.autocast
     */

    const PORT = `$RUNPOD_TCP_PORT_7000` + Object.keys($allModelProcesses.getValue()).length;

    let child = spawn("python3", [
        "~/.bittensor/bittensor/bittensor/_neuron/text/core_server/main.py",
        "--subtensor.chain_endpoint 95.217.192.33:9944",
        "--subtensor.network local",
        "--axon.port "+ PORT,
        "--neuron.device cuda:" + ids[0],
        "--wallet.name miners",
        "--wallet.hotkey " + hotkeyname,
    ]);

    // turn child into rxjs observable with "from"
    let current = $allModelProcesses.getValue();
    let $std = new Observable((observer) => {
        child.stdout.on('data', (data) => {
            observer.next(data.toString());
        });
        child.stdout.on('error', error => observer.error(error))
        child.stdout.on('end', () => observer.complete());
    });

    $allModelProcesses.next({...current, [hotkeyname]: {
        $std,
        process: child,
    }});
    
    // start register
    return { $std, process: child };
}

function GetWalletNames() {
    return getSubdirectories(`${process.env.HOME}/.bittensor/wallets`);
}

function GetKeysForWallet(walletName) {
    const hotkeys = getSubdirectories(`${process.env.HOME}/.bittensor/wallets/${walletName}/hotkeys`, {
        include_files: true
    });

    // load hotkey files
    let keys = hotkeys.map(filename => {
        return { 
            filename: `${process.env.HOME}/.bittensor/wallets/${walletName}/hotkeys/${filename}`,
            json: JSON.parse(readFileSync(`${process.env.HOME}/.bittensor/wallets/${walletName}/hotkeys/${filename}`).toString())
        }
    });

    return keys;;

}