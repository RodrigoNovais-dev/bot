const youtubedl = require('youtube-dl-exec');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');

ffmpeg.setFfmpegPath(ffmpegPath);

async function test() {
    try {
        console.log('Streaming bestaudio with yt-dlp...');
        const subprocess = youtubedl.exec('https://youtube.com/watch?v=kJQP7kiw5Fk', {
            o: '-', // stdout
            f: 'bestaudio',
            noWarnings: true
        });
        
        console.log('Converting to mp3...');
        
        const mp3Stream = ffmpeg(subprocess.stdout)
            .audioCodec('libmp3lame')
            .format('mp3')
            .on('error', (err) => console.error('FFmpeg error:', err))
            .pipe();
            
        const chunks = [];
        mp3Stream.on('data', chunk => chunks.push(chunk));
        mp3Stream.on('end', () => {
            const buffer = Buffer.concat(chunks);
            console.log('Finished converting. MP3 Buffer size:', buffer.length);
            fs.writeFileSync('test-output.mp3', buffer);
        });

    } catch (e) {
        console.error('Catch Error:', e);
    }
}
test();
