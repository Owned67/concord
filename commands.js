let client = null

const permissions = require( './permissions.js' )
const settings = require( './settings.js' )
const _ = require( './helper.js' )

const commands = {}

commands.blacklistedUsers = []
commands.tempBlacklist = []
commands.numSinceBoot = 0
commands.commandList = []

commands.register = params =>
{
    commands.commandList.push( params )
}

commands.getCMD = alias =>
	{
		for ( const i in commands.commandList )
		{
			const cmd = commands.commandList[i]
			if ( cmd.aliases.includes( alias ) )
				return cmd
		}
	}

commands.generateHelp = cmd =>
	{
		let help = settings.get( 'config', 'command_prefix', '!' )

		help += cmd.aliases.join( '|' )
		
		if ( cmd.args )
			help += _.fmt( ' %s', cmd.args )
		
		help += _.fmt( ' - %s', cmd.help )
		
		if ( cmd.flags )
		{
			if ( cmd.flags.includes( 'owner_only' ) )
				help += ' (owner-only)'
			else if ( cmd.flags.includes( 'admin_only' ) )
				help += ' (admin-only)'
		}
		
		return help
	}

commands.findTarget = ( msg, str ) =>
	{
		const matches = []

		const id = /<@!?(\d+)>/g.exec( str )
		if ( id )
		{
			match = client.users.get( id[1] )
			if ( msg.guild )
			{
				const member = msg.guild.members.get( id[1] )
				if ( member )
					match = member
			}
			matches.push( match )		
		}
		else
		{
			str = str.toLowerCase()

			client.users.forEach( user =>
				{
					if ( user.username.toLowerCase().includes( str ) )
						if ( !matches.includes( user ) ) matches.push( user )
					if ( str === user.username.toLowerCase() + '#' + user.discriminator )
						if ( !matches.includes( user ) ) matches.push( user )
				})
			
			if ( msg.guild )
			{
				for ( const i in matches )
				{
					const match = matches[i]
					const member = msg.guild.members.get( match.id )
					if ( member )
						matches[i] = member
				}

				msg.guild.members.forEach( member =>
					{
						if ( member.nickname && member.nickname.toLowerCase().includes( str ) )
							if ( !matches.includes( member ) ) matches.push( member )
						if ( member.user.username.toLowerCase().includes( str ) )
							if ( !matches.includes( member ) ) matches.push( member )
						if ( str === member.user.username.toLowerCase() + '#' + member.user.discriminator )
							if ( !matches.includes( member ) ) matches.push( member )
					})
			}
		}
		
		if ( matches.length === 0 )
		{
			const reply = _.fmt( 'could not find user matching `%s`', str )
			msg.channel.send( reply )
			return false
		}
		
		if ( matches.length > 1 )
		{
			let matchesString = ''
			for ( const i in matches )
			{
				let match = matches[i]
				let nick = ''
				if ( match.user )
				{
					if ( match.nickname )
						nick = '(' + match.nickname + ')'
					match = match.user
				}
				matchesString += _.fmt( '%s#%s %s\n', match.username, match.discriminator, nick )
			}
			const reply = _.fmt( 'found %s matches for `%s`:\n```\n%s```', matches.length, str, matchesString )
			msg.channel.send( reply )
			return false
		}
		
		return matches[0]
	}

commands.findVoiceChannel = ( msg, str ) =>
	{
		const matches = []
		str = str.toLowerCase()
		
		msg.guild.channels.filter( c => c.type === 'voice' ).forEach( ch =>
		{
			if ( ch.name.toLowerCase().includes( str ) )
				if ( !matches.includes( ch ) )
					matches.push( ch )
		})
		
		if ( matches.length === 0 )
		{
			msg.channel.send( _.fmt( 'could not find voice channel matching `%s`', str ) )
			return false
		}
		
		if ( matches.length > 1 )
		{
			let matchesString = ''
			for ( const i in matches )
				matchesString += matches[i].name + '\n'
			msg.channel.send( _.fmt( 'found %s matches for `%s`:\n```\n%s```', matches.length, str, matchesString ) )
			return false
		}
		
		return matches[0]
	}

function checkArgs( cmd, message )
{
	message = message || ''
	if ( !cmd.args )
		return true
	
	const msg_args = message.split( ' ' )
	const cmd_args = cmd.args.split( ' ' )
	for ( const i in cmd_args )
	{
		const cmd_arg = cmd_args[i].trim()
		const msg_arg = msg_args[i]
		
		if ( !msg_arg && cmd_arg.indexOf( '[' ) !== 0 )
			return false
		
		if ( cmd_arg.includes( '|' ) )
		{
			const accepted_args = cmd_arg.split( '|' )
			if ( !accepted_args.includes( msg_arg ) )
				return false
		}
	}
	
	return true
}

function onMessage( msg )
{
	if ( commands.blacklistedUsers.includes( msg.author.id ) ) return
	
	const prefix = settings.get( 'config', 'command_prefix', '!' )
	
	let content = msg.content
	if ( !content.startsWith( prefix ) )
		return
	
	content = content.substring( prefix.length )
	const split = content.split( / (.+)?/ )
	
	const command = split[0].toLowerCase()
	let args = split[1]
	
	if ( args )
		args = args.trim()
	
	for ( const cmd of commands.commandList )
	{
		if ( cmd.aliases.includes( command ) )
		{
			require( './plugins/moderation.js' ).processCooldown( msg.author )
			if ( commands.tempBlacklist.includes( msg.author.id ) ) return
			
			if ( cmd.flags && cmd.flags.includes( 'no_pm' ) && msg.channel.type === 'dm' )
				return msg.channel.send( "can't use this command in private messages" )
			else
				if ( permissions.userHasCommand( msg.author, cmd ) )
				{
					let channelName = 'a direct message'
					if( msg.guild ) 
						channelName = _.fmt( '#%s (%s)', msg.channel.name, msg.guild.name )
					
					// put < > around links so they don't clutter up the owner's crash logs too much
					let fullContent = msg.content
					fullContent = _.filterlinks( fullContent )
					
					commands.numSinceBoot++
					_.log( _.fmt( '%s#%s in %s: %s', msg.author.username, msg.author.discriminator, channelName, fullContent ) )
					
					if ( checkArgs( cmd, args ) )
						return cmd.callback( client, msg, args )
					else
						return msg.channel.send( '```\n' + commands.generateHelp( cmd ) + '\n```' )
				}
				else
					return msg.channel.send( 'insufficient permissions' )
		}
	}
}

commands.init = _cl =>
	{
		client = _cl
		client.on( 'message', msg => onMessage( msg ) )
		commands.blacklistedUsers = settings.get( 'blacklist', null, [] )
		_.log( 'initialized commands' )
	}

module.exports = commands
