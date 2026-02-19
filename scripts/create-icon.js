const sharp = require('sharp')
const pngToIco = require('png-to-ico')
const fs = require('fs')
const path = require('path')

const assetsDir = path.join(__dirname, '..', 'assets')

// Fluxer icon: indigo rounded square with bold white "F"
const svgIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#5865F2"/>
      <stop offset="100%" style="stop-color:#3b47c9"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="56" fill="url(#bg)"/>
  <text x="128" y="196"
        font-family="Arial Black, Arial, sans-serif"
        font-size="180"
        font-weight="900"
        fill="white"
        text-anchor="middle">F</text>
</svg>`

async function createIcons() {
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true })
  }

  const sizes = [16, 32, 48, 64, 128, 256]
  const pngBuffers = []

  for (const size of sizes) {
    const buffer = await sharp(Buffer.from(svgIcon))
      .resize(size, size)
      .png()
      .toBuffer()
    pngBuffers.push(buffer)
  }

  // Save 256px PNG
  fs.writeFileSync(path.join(assetsDir, 'icon.png'), pngBuffers[5])
  console.log('  icon.png created')

  // Convert to multi-size ICO
  const icoBuffer = await pngToIco(pngBuffers)
  fs.writeFileSync(path.join(assetsDir, 'icon.ico'), icoBuffer)
  console.log('  icon.ico created')
}

createIcons()
  .then(() => console.log('Icons ready.'))
  .catch(err => {
    console.error('Icon creation failed:', err.message)
    process.exit(1)
  })
