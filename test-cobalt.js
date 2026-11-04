const axios = require('axios');

async function test() {
    try {
        const res = await axios.post('https://api.cobalt.tools/api/json', {
            url: 'https://www.youtube.com/watch?v=kJQP7kiw5Fk',
            isAudioOnly: true,
            aFormat: 'mp3'
        }, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        });
        console.log('Got response:', res.data);
    } catch (e) {
        console.error('Error:', e.response?.data || e.message);
    }
}
test();
