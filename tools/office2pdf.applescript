-- Régie LED — convertit un fichier PowerPoint, Word ou Excel en PDF en pilotant l'application Office installée.
--   osascript tools/office2pdf.applescript <powerpoint|word|excel> <fichier source> <fichier.pdf de sortie>
-- Le fichier source porte un nom unique (regie-import-xxxx) : le script ne referme QUE ce document-là,
-- jamais un document que l'utilisateur aurait ouvert de son côté.
-- PowerPoint a besoin que le PDF de sortie existe déjà (vide) ; Word et Excel qu'il n'existe pas encore.
on run argv
	set appKind to item 1 of argv
	set srcPath to item 2 of argv
	set dstPath to item 3 of argv
	set srcFile to POSIX file srcPath
	set dstFile to POSIX file dstPath
	set srcName to do shell script "basename " & quoted form of srcPath
	with timeout of 240 seconds
		if appKind is "powerpoint" then
			do shell script "touch " & quoted form of dstPath
			tell application "Microsoft PowerPoint"
				open srcFile
				set pres to missing value
				repeat 60 times
					try
						set pres to presentation srcName
						exit repeat
					end try
					delay 0.5
				end repeat
				if pres is missing value then error "PowerPoint n'a pas pu ouvrir le fichier"
				try
					save pres in dstFile as save as PDF
				on error errMsg
					close pres saving no
					error errMsg
				end try
				close pres saving no
			end tell
		else if appKind is "word" then
			do shell script "rm -f " & quoted form of dstPath
			tell application "Microsoft Word"
				open srcFile
				set opened to false
				repeat 60 times
					try
						if (name of active document) is srcName then
							set opened to true
							exit repeat
						end if
					end try
					delay 0.5
				end repeat
				if not opened then error "Word n'a pas pu ouvrir le fichier"
				try
					save as active document file name dstPath file format format PDF
				on error errMsg
					if (name of active document) is srcName then close active document saving no
					error errMsg
				end try
				if (name of active document) is srcName then close active document saving no
			end tell
		else if appKind is "excel" then
			do shell script "rm -f " & quoted form of dstPath
			tell application "Microsoft Excel"
				open srcFile
				set wb to missing value
				repeat 60 times
					try
						set wb to workbook srcName
						exit repeat
					end try
					delay 0.5
				end repeat
				if wb is missing value then error "Excel n'a pas pu ouvrir le fichier"
				try
					save wb in dstFile as PDF file format
				on error errMsg
					close wb saving no
					error errMsg
				end try
				close wb saving no
			end tell
		else
			error "type inconnu : " & appKind
		end if
	end timeout
	return "ok"
end run
