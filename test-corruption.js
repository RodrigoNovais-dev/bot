const youtubedl = require('youtube-dl-exec');
const ytSearch = require('yt-search');
const fs = require('fs');

async function test() {
    try {
        console.log('Buscando...');
        const searchResult = await ytSearch('Despacito');
        console.log('Found:', searchResult.videos[0].title);
        
        console.log('Streaming m4a with yt-dlp to file...');
        const subprocess = youtubedl.exec(searchResult.videos[0].url, {
            o: '-', // stdout
            f: 'm4a',
            noWarnings: true
        });
        
        const chunks = [];
        subprocess.stdout.on('data', chunk => chunks.push(chunk));
        
        subprocess.stdout.on('end', () => {
            const audioBuffer = Buffer.concat(chunks);
            fs.writeFileSync('test-buffer.m4a', audioBuffer);
            
            // Read first 50 bytes to see if it starts with valid m4a signature
            // m4a should start with something like ftypM4A
            const header = audioBuffer.toString('utf8', 0, 50);
            console.log('Header text:', header);
            console.log('File size:', audioBuffer.length);
        });

    } catch (e) {
        console.error('Catch Error:', e);
    }
}
test();
