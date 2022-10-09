import { readdirSync, statSync } from 'fs';

// get all files within the ~/.bittensor/bittensor
export function walkSync(dir, filelist=[]) {
    let files = readdirSync(dir).map(e => dir + '/' + e)
    files.forEach(file => {
        let stat = statSync(file)
        if (stat.isDirectory()) {
            walkSync(file, filelist)
        }
        filelist.push(file)
    })
    return filelist
}
// let files = walkSync(process.env.HOME + '/.bittensor/wallets')
// let wallets = files.map(filename => {
//     return {
//         filename: filename
//     }
// });
// console.log('files', files);
// get all subdirectiors within the ~/.bittensor/wallets
export const getSubdirectories = (source, {
    include_files
} = {
    include_files: false
}) => {
    const files = readdirSync(source, { withFileTypes: true });
    const folders = files.filter(x => include_files ? x.isDirectory() || x.isFile() : x.isDirectory());
    return folders.map(f => f.name);
};
