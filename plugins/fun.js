let client = null

const commands = require( '../commands.js' )
const permissions = require( '../permissions.js' )
const settings = require( '../settings.js' )
const _ = require( '../helper.js' )

const request = require( 'request' )

function timedMessage( channel, msg, delay )
{
	setTimeout( () => channel.send( msg ), delay )
}

function roll( arg, raw )
{
	if ( !isNaN( arg ) )
		return Math.round( Math.random() * arg )

	const output = []

	const regex = arg.match( /(\d+)d(\d+)/g )
	if ( !regex ) return false

	for ( const die of regex )
	{
		if ( !die ) break

		const res = []
		let total = 0
		
		const parts = /(\d+)d(\d+)/g.exec( die )
		if ( !regex ) return false

		const rolls = parts[1]
		const sides = parts[2]

		for ( let i = 0; i < rolls; i++ )
		{
			const val = Math.round( Math.random() * sides )
			res.push( val )
			total += val
		}

		output.push( { die: die, rolls: res, total: total } )
	}

	return output
}

commands.register( {
	category: 'fun',
	aliases: [ 'roll' ],
	help: 'roll some dice',
	args: 'sides/multidie',
	callback: ( client, msg, args ) =>
	{
		const results = roll( args )

		if ( results === false || results.length === 0 )
			return msg.channel.send( `invalid die syntax: \`${args}\`` )

		if ( !isNaN( results ) )
			return msg.channel.send( _.fmt( '`%s` rolled `%s`', _.nick( msg.member, msg.guild ), results ) )

		let output = ''
		let total = 0
		for ( const d of results )
		{
			output += `${d.die}:\n\t${d.rolls.join(' ')}\n\ttotal: ${d.total}\n`
			total += d.total
		}
		output += `sum: ${total}`

		msg.channel.send( '```' + output + '```' )
	} })

commands.register( {
	category: 'fun',
	aliases: [ 'flip' ],
	help: 'flip a coin, decide your fate',
	callback: ( client, msg, args ) =>
	{
		msg.channel.send( '*flips a coin*' )
		timedMessage( msg.channel, 'wait for it...', 1.5 * 1000 )
		
		const rand = _.rand( 0, 1 )
		const str = [ 'HEADS!', 'TAILS!' ]
		
		timedMessage( msg.channel, str[rand], 3 * 1000 )
	} })

const rouletteCache = {}
commands.register( {
	category: 'fun',
	aliases: [ 'roulette' ],
	flags: [ 'no_pm' ],
	help: 'clench your ass cheeks and pull the trigger',
	callback: ( client, msg, args ) =>
	{
		msg.channel.send( _.fmt( '*`%s` pulls the trigger...*', _.nick( msg.member, msg.guild ) ) )
		
		const guildId = msg.guild.id
		if ( !rouletteCache[ guildId ] )
		{
			rouletteCache[ guildId ] = {}
			rouletteCache[ guildId ].chamber = 0
			rouletteCache[ guildId ].bullet = _.rand( 1, 6 )
		}
		
		rouletteCache[ guildId ].chamber++
		if ( rouletteCache[ guildId ].chamber >= rouletteCache[ guildId ].bullet )
		{
			rouletteCache[ guildId ].chamber = 0
			rouletteCache[ guildId ].bullet = _.rand( 1, 6 )
			timedMessage( msg.channel, '*BANG!*', 2 * 1000 )
		}
		else
			timedMessage( msg.channel, '*click.*', 2 * 1000 )
	} })

commands.register( {
	category: 'fun',
	aliases: [ 'joke' ],
	help: 'provided by your dad, laughter not guaranteed',
	callback: ( client, msg, args ) =>
	{
		request( 'http://www.jokes2go.com/cgi-bin/includejoke.cgi?type=o', ( error, response, body ) =>
			{
				if ( !error && response.statusCode === 200 )
				{
					let text = _.matches( /this.document.write\('(.*)'\);/g, body )[0]
					text = text.replace( /\s{2,}/g, '' )
					text = text.replace( /<\s?br\s?\/?>/g, '\n' )
					text = text.replace( /\\/g, '' )
					msg.channel.send( '```\n' + text + '\n```' )
				}
			})
	} })

commands.register( {
	category: 'fun',
	aliases: [ '8ball' ],
	help: 'ask the magic 8 ball a question',
	args: 'question',
	callback: ( client, msg, args ) =>
	{
		const answers = settings.get( 'fun', '8ball_answers', [ 'It is certain', 'It is decidedly so', 'Without a doubt',
			'Yes, definitely', 'You may rely on it', 'As I see it, yes', 'Most likely', 'Outlook good', 'Yes', 'Signs point to yes',
			'Reply hazy try again', 'Ask again later', 'Better not tell you now', 'Cannot predict now', 'Concentrate and ask again', "Don't count on it",
			'My reply is no', 'My sources say no', 'Outlook not so good', 'Very doubtful' ] )
		
		const max = answers.length - 1
		msg.channel.send( _.fmt( '`%s`', answers[ _.rand( 0, max ) ] ) )
	} })

module.exports.setup = _cl => {
    client = _cl
    _.log( 'loaded plugin: fun' )
}
