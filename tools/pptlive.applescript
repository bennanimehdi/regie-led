-- Régie LED — pilote le diaporama PowerPoint « en direct » (celui que la régie affiche en capturant sa fenêtre).
--   osascript tools/pptlive.applescript open <fichier.pptx>   → ouvre le fichier et lance le diaporama dans une fenêtre
--   osascript tools/pptlive.applescript next | prev | first | pos | stop | park
-- « park » (fait aussi à l'ouverture) : range la fenêtre du diaporama sous le bord bas de l'écran de l'ordinateur (macOS ne laisse
-- dépasser que la barre de titre), toujours sur l'écran principal — jamais sur l'écran des spectateurs, où elle serait visible tant
-- que la sortie n'est pas en plein écran. La capture Chrome inclut le curseur dès qu'il survole la fenêtre, même cachée derrière la
-- régie ; ScreenCaptureKit capture la fenêtre où qu'elle soit, même hors champ.
on parkTarget()
	set jxa to "ObjC.import(\"AppKit\"); const m = $.NSScreen.screens.js[0], f = m.frame, v = m.visibleFrame;" & ¬
		" [Math.round(Math.max(0, f.size.width - 1280)), Math.round(f.size.height - v.origin.y - 20)].join(\",\")"
	set r to do shell script "osascript -l JavaScript -e " & quoted form of jxa
	set AppleScript's text item delimiters to ","
	set parts to text items of r
	set AppleScript's text item delimiters to ""
	return {(item 1 of parts) as integer, (item 2 of parts) as integer}
end parkTarget
-- Renvoie « position/total/hauteur de la fenêtre en points » (ex. « 3/12/768 »). Ne ferme jamais une présentation : aucun risque pour un travail en cours.
on run argv
	set act to item 1 of argv
	with timeout of 90 seconds
		tell application "Microsoft PowerPoint"
			if act is "open" then
				set srcPath to item 2 of argv
				set srcName to do shell script "basename " & quoted form of srcPath
				set pres to missing value
				try
					set pres to presentation srcName
				end try
				if pres is missing value then
					open (POSIX file srcPath)
					repeat 80 times
						try
							set pres to presentation srcName
							exit repeat
						end try
						delay 0.5
					end repeat
				end if
				if pres is missing value then error "PowerPoint n'a pas pu ouvrir le fichier"
				set showSet to slide show settings of pres
				set show type of showSet to slide show type window
				run slide show showSet
				delay 1
				-- Taille connue : 1280 × 768 points = barre de titre + diapositive 16:9 de 1280 × 720 + marge basse (coins arrondis).
				try
					set height of slide show window 1 to 768
					set width of slide show window 1 to 1280
				end try
			end if
			if (count of slide show windows) is 0 then error "aucun diaporama en cours"
			set ssView to slide show view of slide show window 1
			-- Pointeur toujours masqué dans le diaporama : la capture Chrome inclut le curseur de la souris, et sans cela
			-- il apparaîtrait sur le mur dès que la souris passe sur la fenêtre PowerPoint.
			try
				set pointer type of ssView to slide show pointer always hidden
			end try
			if act is "open" or act is "park" then
				try
					set {px, py} to my parkTarget()
					set left position of slide show window 1 to px
					set top of slide show window 1 to py
				end try
				-- Lancer le diaporama met PowerPoint devant : on repasse Chrome devant, sinon la fenêtre PowerPoint
				-- s'affiche par-dessus la sortie sur le 2e écran (en plein écran, la sortie est de toute façon seule sur son écran).
				try
					tell application "Google Chrome" to activate
				end try
			else if act is "next" then
				go to next slide ssView
			else if act is "prev" then
				go to previous slide ssView
			else if act is "first" then
				go to first slide ssView
			else if act is "stop" then
				exit slide show ssView
				return "0/0"
			end if
			set total to count of slides of (presentation of slide show window 1)
			return ((current show position of ssView) as text) & "/" & total & "/" & ((height of slide show window 1) as integer)
		end tell
	end timeout
end run
