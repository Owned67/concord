const Discord = require( 'discord.js' )
const fs = require( 'fs' )

const settings = require( './settings.js' )
const _ = require( './helper.js' )


const client = new Discord.Client()
client.on( 'error', e => _.logError( client, e ) )

const token = settings.get( 'config', 'login_token' )
if ( !token )
{
	const config =
		{
			login_token: '',
			admin_role: 'admin',
			owner_id: '',
			command_prefix: '!',
		}
	settings.save( 'config', config )
		.then( () =>
			{
				console.log( '\nBot has not been configured.\nPlease edit settings/config.json and restart.' )
				process.exit( 8 )
			})
	return
}

		
let initialized = false
client.on( 'ready', e =>
	{		
		_.logEvent( client, 'ready', e )

		const activity = settings.get( 'botactivity', client.user.id, false )
		if ( activity )
			client.user.setActivity( activity.message, { type: activity.type } )

			
		if ( initialized ) return
		initialized = true

		require('./permissions.js').init( client )
		require('./commands.js').init( client )
		require('./plugins.js').load( client )
		_.log( 'bot is ready!' )
		
		if ( fs.existsSync( './crash.log' ) )
		{
			const log = fs.readFileSync( './crash.log', 'utf8' )
			sendOwnerMessage( 'CRASH LOG', log )
			fs.unlinkSync( './crash.log' )
		}
	})

client.on( 'disconnect', e =>
	{
		_.logEvent( client, 'disconnect', e )
		process.exit( 1 )
	})

client.reconnected = false
function checkForReconnection()
{
	if ( !client.reconnected )
	{
		_.log( 'bot not reconnected after timeout, forcing restart' )
		process.exit( 1 )
	}
	else
		_.log( 'bot reconnected, cancelling restart' )
}

client.on( 'reconnecting', e =>
	{
		_.logEvent( client, 'reconnecting', e )
		client.reconnected = false
		setTimeout( checkForReconnection, settings.get( 'config', 'reconnect_timeout', 60 * 1000 ) )
	})
client.on( 'resume', e =>
	{
		_.logEvent( client, 'resume', e )
		client.reconnected = true
	})

client.on( 'guildCreate', e => _.logEvent( client, 'guildCreate', e ) )
client.on( 'guildDelete', e => _.logEvent( client, 'guildDelete', e ) )
client.on( 'guildUnavailable', e => _.logEvent( client, 'guildUnavailable', e ) )

client.login( token )
	.catch( e =>
	{
		_.logError( client, e )
	})


function sendOwnerMessage( type, msg )
{
	const owner = client.users.get( settings.get( 'config', 'owner_id', '' ) )
	if ( owner )
		owner.createDM().then( d => d.send( `***${type}***\n\`\`\`\n${msg}\n\`\`\`` ) )
	else
		_.log( 'WARNING: no owner to send error log to' )
}

process.on( 'uncaughtException', ( ex ) =>
	{
		console.log( ex.stack )
		sendOwnerMessage( 'uncaughtException', ex.stack )
	})

process.on( 'unhandledRejection', ( reason, p ) =>
	{
		const err = `${p}\n${reason.stack}`
		console.log( err )
		sendOwnerMessage( 'unhandledRejection', err )
	})
