const youtubedl = require('youtube-dl-exec');
const fs = require('fs');

async function test() {
    try {
        console.log('Downloading tiktok video...');
        const subprocess = youtubedl.exec('https://www.tiktok.com/@tiktok/video/7106594312292453675', {
            f: 'best',
            o: 'temp-tiktok.mp4',
            noWarnings: true
        });

        subprocess.on('close', (code) => {
            console.log('Process finished with code', code);
            if(fs.existsSync('temp-tiktok.mp4')) {
                const stats = fs.statSync('temp-tiktok.mp4');
                console.log('File size:', stats.size);
            }
        });
        subprocess.on('error', (err) => console.error('Error:', err));
    } catch (e) {
        console.error('Catch Error:', e);
    }
}
test();
