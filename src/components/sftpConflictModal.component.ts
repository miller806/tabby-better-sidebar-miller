import { AfterViewInit, Component, ElementRef, Input, OnInit, ViewChild } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { SidebarPlusI18nService } from '../i18n'

/** What the user decided about a name that is already taken. */
export type ConflictChoice = 'overwrite'|'rename'|'skip'

export interface ConflictAnswer {
    choice: ConflictChoice
    /** The user asked for this answer to cover every remaining collision. */
    applyToAll: boolean
}

/**
 * The three-way question a name collision deserves, in this plugin's own HTML
 * modal rather than a native OS dialog (piège #42).
 *
 * Three answers, not two: "overwrite or give up" forces the user to delete the
 * remote file first just to keep both, which is what this dialog replaced.
 * Nothing destructive is the default — `Entrée` keeps both.
 */
@Component({
    selector: 'sidebar-plus-conflict-modal',
    template: require('./sftpConflictModal.component.pug'),
})
export class SftpConflictModalComponent implements OnInit, AfterViewInit {
    /** The name that is already taken. */
    @Input() name = ''
    /** Where it lives, so the question is about a place and not just a name. */
    @Input() destination = ''
    /** True when more collisions are queued behind this one — see `applyToAll`. */
    @Input() many = false

    applyToAll = false

    headline = ''
    detail = ''
    renameLabel = ''
    overwriteLabel = ''
    skipLabel = ''
    applyAllLabel = ''

    @ViewChild('renameButton') renameButton: ElementRef<HTMLButtonElement>

    constructor (private modalInstance: NgbActiveModal, private i18n: SidebarPlusI18nService) {
        this.detail = this.i18n.t('Keep both renames the file that is being uploaded; overwrite replaces the one on the server.')
        this.renameLabel = this.i18n.t('Keep both')
        this.overwriteLabel = this.i18n.t('Overwrite')
        this.skipLabel = this.i18n.t('Skip')
        this.applyAllLabel = this.i18n.t('Do this for the remaining files')
    }

    /**
     * Composed here and not in the constructor: the caller assigns `name` and
     * `destination` right after `open()`, so a message built at construction
     * would name nothing at all.
     */
    ngOnInit (): void {
        this.headline = this.i18n.t('"{name}" already exists in {destination}.', {
            name: this.name,
            destination: this.destination,
        })
    }

    ngAfterViewInit (): void {
        // NgbModal fades its window in, and focusing an element that is still
        // animating in silently does nothing.
        setTimeout(() => this.renameButton?.nativeElement.focus())
    }

    rename (): void {
        this.answer('rename')
    }

    overwrite (): void {
        this.answer('overwrite')
    }

    skip (): void {
        this.answer('skip')
    }

    private answer (choice: ConflictChoice): void {
        this.modalInstance.close({ choice, applyToAll: this.applyToAll } as ConflictAnswer)
    }
}
